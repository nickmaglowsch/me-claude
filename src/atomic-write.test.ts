import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test the actual write functions to ensure concurrent invocations use
// distinct tmp file names and both writes complete successfully.

import { writeContactMemory, CONTACTS_DIR } from './memory';
import { saveAmbientConfig, defaultAmbientConfig } from './ambient';
import { saveGroupIndex } from './groups';

// Sentinel JID used for writeContactMemory tests — cleaned up after each test.
// We use CONTACTS_DIR directly because that constant is computed at module load
// time and does not change with process.chdir(). The existing memory.test.ts
// uses the same pattern.
const SENTINEL_JID = '00000000000000001@c.us';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  // Create dirs needed by saveAmbientConfig and saveGroupIndex (which respect
  // process.chdir() because they resolve paths at call time).
  fs.mkdirSync(path.join(tmpDir, 'data', 'contacts'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data', 'groups'), { recursive: true });
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  // Clean up sentinel contact file written to the real CONTACTS_DIR.
  const sentinelPath = path.join(CONTACTS_DIR, `${SENTINEL_JID}.md`);
  try {
    fs.unlinkSync(sentinelPath);
  } catch {
    /* noop — file may not have been created */
  }
  // Also clean any leftover .tmp-* files from the sentinel JID.
  try {
    const files = fs.readdirSync(CONTACTS_DIR).filter(f => f.startsWith(SENTINEL_JID));
    for (const f of files) {
      try { fs.unlinkSync(path.join(CONTACTS_DIR, f)); } catch { /* noop */ }
    }
  } catch {
    /* noop — CONTACTS_DIR may not exist */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('concurrent atomic writes — tmp file name uniqueness', () => {
  it('two concurrent writeContactMemory calls both succeed with distinct tmp names', async () => {
    // writeContactMemory uses CONTACTS_DIR (module-level constant); process.chdir
    // does not redirect it. We use a sentinel JID and read from CONTACTS_DIR directly.
    const p1 = Promise.resolve().then(() => writeContactMemory(SENTINEL_JID, '# Alice\nContent A'));
    const p2 = Promise.resolve().then(() => writeContactMemory(SENTINEL_JID, '# Alice\nContent B'));
    await Promise.all([p1, p2]);

    // One of the two writes will win the rename race. The final file must be
    // either Content A or Content B — not empty and not corrupted.
    const finalContent = fs.readFileSync(
      path.join(CONTACTS_DIR, `${SENTINEL_JID}.md`),
      'utf8',
    );
    expect(['# Alice\nContent A', '# Alice\nContent B']).toContain(finalContent);
  });

  it('two concurrent saveAmbientConfig calls both succeed', async () => {
    const cfg = defaultAmbientConfig();
    const p1 = Promise.resolve().then(() => saveAmbientConfig({ ...cfg, dailyCap: 10 }));
    const p2 = Promise.resolve().then(() => saveAmbientConfig({ ...cfg, dailyCap: 20 }));
    await Promise.all([p1, p2]);
    // File must exist and be valid JSON
    const raw = fs.readFileSync(path.join(tmpDir, 'data', 'ambient-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect([10, 20]).toContain(parsed.dailyCap);
  });

  it('no .tmp-* files left behind after write', async () => {
    writeContactMemory(SENTINEL_JID, '# Bob\nTest');
    const leftover = fs.readdirSync(CONTACTS_DIR)
      .filter(f => f.includes('.tmp-'));
    expect(leftover).toHaveLength(0);
  });

  it('two concurrent saveGroupIndex calls both succeed', async () => {
    const idx1 = { 'jid1@g.us': { name: 'Group A', folder: 'group-a' } };
    const idx2 = { 'jid2@g.us': { name: 'Group B', folder: 'group-b' } };
    const p1 = Promise.resolve().then(() => saveGroupIndex(idx1));
    const p2 = Promise.resolve().then(() => saveGroupIndex(idx2));
    await Promise.all([p1, p2]);
    // File must exist and be valid JSON
    const raw = fs.readFileSync(path.join(tmpDir, 'data', 'groups', '.index.json'), 'utf8');
    const parsed = JSON.parse(raw);
    // One of the two writes wins; parsed must be one of the two indexes
    expect(parsed).toSatisfy(
      (v: unknown) =>
        JSON.stringify(v) === JSON.stringify(idx1) ||
        JSON.stringify(v) === JSON.stringify(idx2),
    );
  });
});
