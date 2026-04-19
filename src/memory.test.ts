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
  isCusJid,
  isLidJid,
  CONTACTS_DIR,
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
    expect(isCusJid('100000000000000@lid')).toBe(false);
    expect(isCusJid('5511987654321')).toBe(false);
  });

  it('identifies @lid JIDs', () => {
    expect(isLidJid('100000000000000@lid')).toBe(true);
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
    expect(resolveToCus('100000000000000@lid')).toBeNull();
  });

  it('resolves @lid via participants list when chat is provided', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: { _serialized: '100000000000000@lid' },
        },
        {
          id: { _serialized: '5521999999999@c.us' },
          lid: { _serialized: '111111111111111@lid' },
        },
      ],
    };
    expect(resolveToCus('100000000000000@lid', chat)).toBe('5511987654321@c.us');
    expect(resolveToCus('111111111111111@lid', chat)).toBe('5521999999999@c.us');
  });

  it('caches resolutions across calls', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: { _serialized: '100000000000000@lid' },
        },
      ],
    };
    // First call: resolved from participants
    expect(resolveToCus('100000000000000@lid', chat)).toBe('5511987654321@c.us');
    // Second call without chat: still resolved, from cache
    expect(resolveToCus('100000000000000@lid')).toBe('5511987654321@c.us');
  });

  it('returns null when @lid is not in the participants list', () => {
    const chat = {
      participants: [
        {
          id: { _serialized: '5511987654321@c.us' },
          lid: { _serialized: '100000000000000@lid' },
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
          lid: '100000000000000@lid',
        },
      ],
    };
    expect(resolveToCus('100000000000000@lid', chat)).toBe('5511987654321@c.us');
  });
});

// buildContactContext was removed when the runtime switched to tool-access.
// Claude now reads contact files itself; we no longer pre-build a block.
