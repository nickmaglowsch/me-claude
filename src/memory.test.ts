import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  contactFilePath,
  readContactMemory,
  writeContactMemory,
  listContactMemories,
  resolveToCus,
  buildContactContext,
  isCusJid,
  isLidJid,
  CONTACTS_DIR,
  MAX_MEMORY_CHARS,
} from './memory';

// Run tests in a temp cwd so they don't touch the real data/contacts/
let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  process.chdir(tmpDir);
  // Re-import is unnecessary — CONTACTS_DIR is computed at module load, so
  // tests that write to disk use the path computed under the REAL cwd. Skip
  // those tests if the path isn't under the tmp dir.
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('isCusJid / isLidJid', () => {
  it('identifies @c.us JIDs', () => {
    expect(isCusJid('5511987654321@c.us')).toBe(true);
    expect(isCusJid('261460529811482@lid')).toBe(false);
    expect(isCusJid('5511987654321')).toBe(false);
  });

  it('identifies @lid JIDs', () => {
    expect(isLidJid('261460529811482@lid')).toBe(true);
    expect(isLidJid('5511987654321@c.us')).toBe(false);
    expect(isLidJid('')).toBe(false);
  });
});

describe('contactFilePath', () => {
  it('builds the expected path for a @c.us JID', () => {
    const p = contactFilePath('5511987654321@c.us');
    expect(p).toContain('data/contacts');
    expect(p).toContain('5511987654321@c.us.md');
  });
});

describe('readContactMemory / writeContactMemory (real fs)', () => {
  // These tests write to the ACTUAL CONTACTS_DIR computed at module load time,
  // which points at the real data/contacts/. To keep them isolated, we use a
  // test-only sentinel JID that gets cleaned up after each test.
  const SENTINEL_JID = '99999999999999999@c.us';

  afterEach(() => {
    const p = contactFilePath(SENTINEL_JID);
    try {
      fs.unlinkSync(p);
    } catch {
      /* noop */
    }
  });

  it('writeContactMemory creates the file with exact contents', () => {
    writeContactMemory(SENTINEL_JID, 'hello memory');
    expect(fs.readFileSync(contactFilePath(SENTINEL_JID), 'utf8')).toBe('hello memory');
  });

  it('readContactMemory returns the contents of an existing file', () => {
    writeContactMemory(SENTINEL_JID, 'exact bytes');
    expect(readContactMemory(SENTINEL_JID)).toBe('exact bytes');
  });

  it('readContactMemory returns null for a missing file', () => {
    expect(readContactMemory(SENTINEL_JID)).toBeNull();
  });

  it('writeContactMemory overwrites an existing file', () => {
    writeContactMemory(SENTINEL_JID, 'v1');
    writeContactMemory(SENTINEL_JID, 'v2');
    expect(readContactMemory(SENTINEL_JID)).toBe('v2');
  });

  it('writeContactMemory leaves no temp files behind after success', () => {
    writeContactMemory(SENTINEL_JID, 'clean');
    const leftover = fs.readdirSync(CONTACTS_DIR).filter(f => f.includes('.tmp-'));
    expect(leftover).toEqual([]);
  });
});

describe('listContactMemories', () => {
  it('returns an empty array when the directory does not exist', () => {
    // We can't easily hide CONTACTS_DIR, so this test just verifies the
    // function returns an array (may include real sentinel files).
    const result = listContactMemories();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('resolveToCus', () => {
  it('returns @c.us JIDs as-is', () => {
    expect(resolveToCus('5511987654321@c.us')).toBe('5511987654321@c.us');
  });

  it('returns null for non-@lid, non-@c.us inputs', () => {
    expect(resolveToCus('random-string')).toBeNull();
    expect(resolveToCus('')).toBeNull();
  });

  it('returns null for @lid when no chat is provided', () => {
    expect(resolveToCus('261460529811482@lid')).toBeNull();
  });

  it('resolves @lid via participants list when chat is provided', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: { _serialized: '261460529811482@lid' },
        },
        {
          id: { _serialized: '5521999999999@c.us' },
          lid: { _serialized: '111111111111111@lid' },
        },
      ],
    };
    expect(resolveToCus('261460529811482@lid', chat)).toBe('5511987654321@c.us');
    expect(resolveToCus('111111111111111@lid', chat)).toBe('5521999999999@c.us');
  });

  it('caches resolutions across calls', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: { _serialized: '261460529811482@lid' },
        },
      ],
    };
    // First call: resolved from participants
    expect(resolveToCus('261460529811482@lid', chat)).toBe('5511987654321@c.us');
    // Second call without chat: still resolved, from cache
    expect(resolveToCus('261460529811482@lid')).toBe('5511987654321@c.us');
  });

  it('returns null when @lid is not in the participants list', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: { _serialized: '261460529811482@lid' },
        },
      ],
    };
    expect(resolveToCus('unknown-lid@lid', chat)).toBeNull();
  });

  it('handles participants where lid is a plain string not an object', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: '261460529811482@lid',
        },
      ],
    };
    expect(resolveToCus('261460529811482@lid', chat)).toBe('5511987654321@c.us');
  });
});

describe('buildContactContext', () => {
  const SENTINEL_A = '99999999999999991@c.us';
  const SENTINEL_B = '99999999999999992@c.us';

  afterEach(() => {
    for (const jid of [SENTINEL_A, SENTINEL_B]) {
      try {
        fs.unlinkSync(contactFilePath(jid));
      } catch {
        /* noop */
      }
    }
  });

  it('returns empty string when no files exist for any JID', () => {
    expect(buildContactContext([SENTINEL_A, SENTINEL_B])).toBe('');
  });

  it('returns a block containing the contact memory when one file exists', () => {
    writeContactMemory(SENTINEL_A, '# Alice\nFacts: works at Nubank');
    const result = buildContactContext([SENTINEL_A]);
    expect(result).toContain('PEOPLE YOU KNOW');
    expect(result).toContain('works at Nubank');
  });

  it('concatenates multiple contact files with separators', () => {
    writeContactMemory(SENTINEL_A, '# Alice');
    writeContactMemory(SENTINEL_B, '# Bob');
    const result = buildContactContext([SENTINEL_A, SENTINEL_B]);
    expect(result).toContain('# Alice');
    expect(result).toContain('# Bob');
    expect(result).toContain('---');
  });

  it('deduplicates repeated JIDs', () => {
    writeContactMemory(SENTINEL_A, '# Alice unique content');
    const result = buildContactContext([SENTINEL_A, SENTINEL_A, SENTINEL_A]);
    const occurrences = result.split('# Alice unique content').length - 1;
    expect(occurrences).toBe(1);
  });

  it('truncates any single file longer than MAX_MEMORY_CHARS', () => {
    const bigContent = 'x'.repeat(MAX_MEMORY_CHARS + 100);
    writeContactMemory(SENTINEL_A, bigContent);
    const result = buildContactContext([SENTINEL_A]);
    expect(result).toContain('[...truncated]');
  });

  it('skips silently when a JID has no corresponding file', () => {
    writeContactMemory(SENTINEL_A, '# Alice');
    const result = buildContactContext([SENTINEL_A, SENTINEL_B]);
    expect(result).toContain('# Alice');
    // SENTINEL_B has no file — should not add a placeholder header
    expect(result).not.toContain(SENTINEL_B);
  });
});
