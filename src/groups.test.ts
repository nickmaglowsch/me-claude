import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  slugifyGroupName,
  loadGroupIndex,
  saveGroupIndex,
  ensureGroupFolder,
  persistMessage,
  readDayMessages,
  listDays,
  findGroupsByName,
  localDate,
  groupsDirAbs,
  indexPath,
  groupFolderPath,
  dayFilePath,
  GROUPS_DIR,
} from './groups';
import type { PersistedMessage, GroupIndex } from './groups';

// Isolation: run each test in a fresh tmp dir so real data/groups/ is never touched.
let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'groups-test-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// slugifyGroupName
// ---------------------------------------------------------------------------
describe('slugifyGroupName', () => {
  it('plain lowercase: "mgz" → "mgz"', () => {
    expect(slugifyGroupName('mgz', 'fallback')).toBe('mgz');
  });

  it('multiple words with space: "Bate Papo" → "bate-papo"', () => {
    expect(slugifyGroupName('Bate Papo', 'f')).toBe('bate-papo');
  });

  it('diacritics stripped: "OE Açaí" → "oe-acai"', () => {
    expect(slugifyGroupName('OE Açaí', 'f')).toBe('oe-acai');
  });

  it('emojis stripped: "🇧🇷 RepTime BR" → "reptime-br"', () => {
    expect(slugifyGroupName('🇧🇷 RepTime BR', 'f')).toBe('reptime-br');
  });

  it('empty after normalization uses fallback: "🎉" → "12345"', () => {
    expect(slugifyGroupName('🎉', '12345')).toBe('12345');
  });

  it('collapses repeated non-alphanumeric runs: "a   -  b" → "a-b"', () => {
    expect(slugifyGroupName('a   -  b', 'f')).toBe('a-b');
  });

  it('trims leading/trailing dashes: "---mgz---" → "mgz"', () => {
    expect(slugifyGroupName('---mgz---', 'f')).toBe('mgz');
  });

  // --- safety-net: adversarial names must not produce traversal paths ---------
  // These lock in the current sanitization behavior so task-02 (hash suffix)
  // cannot accidentally regress the traversal protection.

  it('path traversal "../../etc/passwd" → does not produce a slug starting with "/" or containing ".."', () => {
    const slug = slugifyGroupName('../../etc/passwd', 'fallback');
    expect(slug).not.toContain('..');
    expect(slug).not.toMatch(/^\//);
    expect(slug.length).toBeGreaterThan(0);
  });

  it('all-asterisks "***" → fallback (empty after normalization)', () => {
    const slug = slugifyGroupName('***', 'fallback');
    // normalize() strips punctuation; "***" becomes "" → falls back
    expect(slug).toBe('fallback');
  });

  it('fire emoji "🔥group" → slug contains "group" and is not absolute', () => {
    const slug = slugifyGroupName('🔥group', 'fallback');
    expect(slug).toContain('group');
    expect(slug).not.toMatch(/^\//);
    expect(slug).not.toContain('..');
  });

  it('slug containing only slashes and dots → fallback used (no traversal)', () => {
    const slug = slugifyGroupName('../..', 'safe-fallback');
    // normalize strips dots and slashes → empty → fallback
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('..');
    // Either the fallback or a sanitized non-empty string, but never "." or ".."
    expect(slug).not.toBe('.');
    expect(slug).not.toBe('..');
  });

  it('slug result is never an absolute path regardless of input', () => {
    const adversarial = [
      '/etc/passwd',
      '//etc//passwd',
      '/root',
      '../../../root',
      '\0null',
    ];
    for (const input of adversarial) {
      const slug = slugifyGroupName(input, 'safe');
      expect(slug).not.toMatch(/^\//);
      expect(slug).not.toContain('..');
    }
  });
});

// ---------------------------------------------------------------------------
// Index I/O
// ---------------------------------------------------------------------------
describe('loadGroupIndex', () => {
  it('returns {} when file is missing', () => {
    expect(loadGroupIndex()).toEqual({});
  });

  it('returns {} on malformed JSON (logs warning)', () => {
    const dir = groupsDirAbs();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexPath(), 'NOT JSON', 'utf8');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = loadGroupIndex();
    expect(result).toEqual({});
    expect(spy).toHaveBeenCalled();
  });
});

describe('saveGroupIndex + loadGroupIndex roundtrip', () => {
  it('preserves entries after roundtrip', () => {
    const idx: GroupIndex = {
      '1234567890@g.us': { name: 'mgz', folder: 'mgz' },
    };
    saveGroupIndex(idx);
    expect(loadGroupIndex()).toEqual(idx);
  });

  it('creates data/groups/ directory if missing', () => {
    // dir does not exist yet (fresh tmpDir)
    expect(fs.existsSync(groupsDirAbs())).toBe(false);
    saveGroupIndex({});
    expect(fs.existsSync(groupsDirAbs())).toBe(true);
  });

  it('leaves no .tmp-* files behind after save', () => {
    saveGroupIndex({ 'a@g.us': { name: 'a', folder: 'a' } });
    const leftover = fs.readdirSync(groupsDirAbs()).filter(f => f.includes('.tmp-'));
    expect(leftover).toHaveLength(0);
  });

  // --- safety-net: correct final content on overwrite ------------------------
  // Protects task-05 (random tmp naming + O_EXCL) from regressing overwrite.
  it('second save fully replaces first: only second entry survives', () => {
    const v1: GroupIndex = { 'old@g.us': { name: 'old group', folder: 'old-group' } };
    const v2: GroupIndex = { 'new@g.us': { name: 'new group', folder: 'new-group' } };

    saveGroupIndex(v1);
    saveGroupIndex(v2);

    const loaded = loadGroupIndex();
    expect(loaded['new@g.us']).toEqual({ name: 'new group', folder: 'new-group' });
    expect(loaded['old@g.us']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ensureGroupFolder
// ---------------------------------------------------------------------------
describe('ensureGroupFolder', () => {
  it('new JID: creates index entry, returns slug with JID hash suffix', () => {
    const folder = ensureGroupFolder('111@g.us', 'mgz');
    // With hash suffix: "mgz-93d7c9" (sha256("111@g.us").slice(0,6))
    expect(folder).toMatch(/^mgz-[0-9a-f]{6}$/);
    const idx = loadGroupIndex();
    expect(idx['111@g.us']).toEqual({ name: 'mgz', folder });
  });

  it('existing JID: returns cached folder without re-slugging', () => {
    const original = ensureGroupFolder('111@g.us', 'mgz');
    // Call again with a different name — should still return original folder
    const folder = ensureGroupFolder('111@g.us', 'something else entirely');
    expect(folder).toBe(original);
  });

  it('collision: two JIDs with same chat name get distinct folders via JID hash', () => {
    const folder1 = ensureGroupFolder('111@g.us', 'mgz');
    const folder2 = ensureGroupFolder('222@g.us', 'mgz');
    // Different JIDs → different hashes → no collision, no "-2" needed
    expect(folder1).not.toBe(folder2);
    expect(folder1).toMatch(/^mgz-[0-9a-f]{6}$/);
    expect(folder2).toMatch(/^mgz-[0-9a-f]{6}$/);
  });

  it('collision counter: "-2" suffix used when hash+slug already exists in index', () => {
    // Pre-populate the index with an entry that occupies the exact baseSlug
    // that '111@g.us' would generate, forcing the counter fallback.
    const jid = '111@g.us';
    const firstFolder = ensureGroupFolder(jid, 'mgz');
    // Delete that JID from the index so we can test the counter with another JID
    // that happens to want the same folder. Manually craft such a scenario:
    // save the first-JID's folder as belonging to a phantom JID, then register a
    // new JID that produces the same baseSlug (impossible in practice since hashes
    // differ, so simulate by pre-occupying the slot).
    saveGroupIndex({ 'phantom@g.us': { name: 'mgz', folder: firstFolder } });
    // Now register the real JID — its baseSlug ("mgz-93d7c9") is taken, so it
    // must use the counter fallback.
    const folder2 = ensureGroupFolder(jid, 'mgz');
    expect(folder2).toBe(`${firstFolder}-2`);
  });

  it('three collisions: counter increments correctly past occupied slots', () => {
    const jid = '111@g.us';
    const baseFolder = ensureGroupFolder(jid, 'mgz');
    // Occupy baseFolder and baseFolder-2 under phantom JIDs
    saveGroupIndex({
      'phantom1@g.us': { name: 'mgz', folder: baseFolder },
      'phantom2@g.us': { name: 'mgz', folder: `${baseFolder}-2` },
    });
    // Next registration of the same JID must skip to "-3"
    const folder3 = ensureGroupFolder(jid, 'mgz');
    expect(folder3).toBe(`${baseFolder}-3`);
  });

  // --- safety-net: idempotency ------------------------------------------------
  // Calling ensureGroupFolder twice with the same JID must return the same path.
  // This protects task-02 (hash suffix) from accidentally breaking the cache.
  it('idempotency: second call with same JID returns identical folder path', () => {
    const first = ensureGroupFolder('idempotent@g.us', 'my group');
    const second = ensureGroupFolder('idempotent@g.us', 'my group');
    expect(second).toBe(first);
  });

  it('idempotency: second call with same JID but DIFFERENT name still returns original folder', () => {
    const first = ensureGroupFolder('stable-jid@g.us', 'original name');
    const second = ensureGroupFolder('stable-jid@g.us', 'completely different name');
    expect(second).toBe(first);
  });

  // --- safety-net: adversarial group names do not produce traversal paths -----
  it('adversarial group name "../../etc" does not produce a folder containing ".."', () => {
    const folder = ensureGroupFolder('evil@g.us', '../../etc');
    expect(folder).not.toContain('..');
    expect(folder).not.toMatch(/^\//);
    // The resulting folder must be a safe relative segment
    const resolvedPath = path.join(groupsDirAbs(), folder);
    // resolved path must be a strict child of groupsDirAbs (no traversal above it)
    expect(resolvedPath.startsWith(groupsDirAbs())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// persistMessage + readDayMessages
// ---------------------------------------------------------------------------
function makeMsg(overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    ts: '2026-04-18T14:32:11.000Z',
    local_date: '2026-04-18',
    from_jid: '5511@c.us',
    from_name: 'Alice',
    body: 'hello',
    from_me: false,
    type: 'chat',
    id: 'msg-001',
    has_quoted: false,
    quoted_id: null,
    ...overrides,
  };
}

describe('persistMessage + readDayMessages', () => {
  it('single message persisted: readDayMessages returns identical record', () => {
    const msg = makeMsg();
    const folder = ensureGroupFolder('111@g.us', 'mgz');
    persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg });
    const result = readDayMessages(folder, '2026-04-18');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(msg);
  });

  it('multiple messages same day: order preserved', () => {
    const msg1 = makeMsg({ id: 'msg-001', body: 'first' });
    const msg2 = makeMsg({ id: 'msg-002', body: 'second' });
    const msg3 = makeMsg({ id: 'msg-003', body: 'third' });
    const folder = ensureGroupFolder('111@g.us', 'mgz');
    persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg: msg1 });
    persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg: msg2 });
    persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg: msg3 });
    const result = readDayMessages(folder, '2026-04-18');
    expect(result).toHaveLength(3);
    expect(result[0].body).toBe('first');
    expect(result[1].body).toBe('second');
    expect(result[2].body).toBe('third');
  });

  it('messages on different days go to different files', () => {
    const msg1 = makeMsg({ id: 'msg-a', local_date: '2026-04-18', ts: '2026-04-18T10:00:00.000Z' });
    const msg2 = makeMsg({ id: 'msg-b', local_date: '2026-04-19', ts: '2026-04-19T10:00:00.000Z' });
    const folder = ensureGroupFolder('111@g.us', 'mgz');
    persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg: msg1 });
    persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg: msg2 });
    const day18 = readDayMessages(folder, '2026-04-18');
    const day19 = readDayMessages(folder, '2026-04-19');
    expect(day18).toHaveLength(1);
    expect(day18[0].id).toBe('msg-a');
    expect(day19).toHaveLength(1);
    expect(day19[0].id).toBe('msg-b');
  });

  it('malformed JSONL line: readDayMessages skips it and returns valid ones', () => {
    const msg = makeMsg({ id: 'good-msg' });
    // Manually create the file with one bad line and one good line
    const dir = groupFolderPath('mgz');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = dayFilePath('mgz', '2026-04-18');
    fs.writeFileSync(filePath, 'NOT VALID JSON\n' + JSON.stringify(msg) + '\n', 'utf8');

    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = readDayMessages('mgz', '2026-04-18');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('good-msg');
    expect(spy).toHaveBeenCalled();
  });

  it('persistMessage on permission error does not throw', () => {
    // Make the groups dir read-only after creating it
    const dir = groupFolderPath('mgz');
    fs.mkdirSync(dir, { recursive: true });

    // Mock appendFileSync to throw a permission error
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const msg = makeMsg();
    expect(() => persistMessage({ chatJid: '111@g.us', chatName: 'mgz', msg })).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();

    appendSpy.mockRestore();
  });

  it('readDayMessages returns [] for missing file', () => {
    const result = readDayMessages('nonexistent-folder', '2026-04-18');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listDays
// ---------------------------------------------------------------------------
describe('listDays', () => {
  it('empty folder: returns []', () => {
    const dir = groupFolderPath('mgz');
    fs.mkdirSync(dir, { recursive: true });
    expect(listDays('mgz')).toEqual([]);
  });

  it('folder does not exist: returns []', () => {
    expect(listDays('nonexistent')).toEqual([]);
  });

  it('3 date files → returns 3 strings sorted descending', () => {
    const dir = groupFolderPath('mgz');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-04-16.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, '2026-04-18.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(dir, '2026-04-17.jsonl'), '', 'utf8');
    const result = listDays('mgz');
    expect(result).toEqual(['2026-04-18', '2026-04-17', '2026-04-16']);
  });
});

// ---------------------------------------------------------------------------
// findGroupsByName
// ---------------------------------------------------------------------------
describe('findGroupsByName', () => {
  it('empty index: returns []', () => {
    expect(findGroupsByName('mgz')).toEqual([]);
  });

  it('exact match: query "mgz" with entry "mgz" → returns it with high score', () => {
    saveGroupIndex({ '111@g.us': { name: 'mgz', folder: 'mgz' } });
    const results = findGroupsByName('mgz');
    expect(results).toHaveLength(1);
    expect(results[0].jid).toBe('111@g.us');
    expect(results[0].score).toBeGreaterThan(0.8);
  });

  it('fuzzy match: query "reptime" with entry "RepTime BR" → matches with score > threshold', () => {
    saveGroupIndex({ '222@g.us': { name: 'RepTime BR', folder: 'reptime-br' } });
    const results = findGroupsByName('reptime');
    expect(results).toHaveLength(1);
    expect(results[0].folder).toBe('reptime-br');
    expect(results[0].score).toBeGreaterThan(0.4);
  });

  it('no match: query "asdfgh" with unrelated entries → returns []', () => {
    saveGroupIndex({
      '111@g.us': { name: 'mgz', folder: 'mgz' },
      '222@g.us': { name: 'RepTime BR', folder: 'reptime-br' },
    });
    const results = findGroupsByName('asdfgh');
    expect(results).toEqual([]);
  });

  it('returns results sorted by score descending', () => {
    // Both entries match "reptime" above threshold 0.4:
    //   "RepTime BR" scores ~0.8, "RepTime Sao Paulo" scores ~0.54
    saveGroupIndex({
      '111@g.us': { name: 'RepTime BR', folder: 'reptime-br' },
      '222@g.us': { name: 'RepTime Sao Paulo', folder: 'reptime-sp' },
    });
    const results = findGroupsByName('reptime');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // "RepTime BR" should score higher than "RepTime Sao Paulo"
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });
});

// ---------------------------------------------------------------------------
// localDate
// ---------------------------------------------------------------------------
describe('localDate', () => {
  it('localDate returns local-timezone YYYY-MM-DD', () => {
    // Pick a timestamp near local midnight so UTC-vs-local divergence shows.
    // 2026-04-18T03:00:00Z is midnight or earlier for UTC-3 through UTC+1
    // zones, meaning the local date may differ from the UTC date depending on
    // the machine's timezone. We compute the expected value the same way the
    // implementation does (toLocaleDateString('en-CA')) and assert exact equality.
    const ts = new Date('2026-04-18T03:00:00Z').getTime();
    const expected = new Date(ts).toLocaleDateString('en-CA');
    expect(localDate(ts)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Path helpers (sanity checks)
// ---------------------------------------------------------------------------
describe('path helpers', () => {
  it('GROUPS_DIR is "data/groups"', () => {
    expect(GROUPS_DIR).toBe('data/groups');
  });

  it('groupsDirAbs returns path under cwd', () => {
    expect(groupsDirAbs()).toBe(path.join(process.cwd(), 'data', 'groups'));
  });

  it('indexPath returns .index.json under groups dir', () => {
    expect(indexPath()).toBe(path.join(groupsDirAbs(), '.index.json'));
  });

  it('groupFolderPath returns path for a given folder', () => {
    expect(groupFolderPath('mgz')).toBe(path.join(groupsDirAbs(), 'mgz'));
  });

  it('dayFilePath returns JSONL path for folder + date', () => {
    expect(dayFilePath('mgz', '2026-04-18')).toBe(
      path.join(groupsDirAbs(), 'mgz', '2026-04-18.jsonl'),
    );
  });
});

// ---------------------------------------------------------------------------
// ensureGroupFolder — jid hash suffix
// ---------------------------------------------------------------------------
describe('ensureGroupFolder — jid hash suffix', () => {
  it('new group folder includes 6-char hex suffix derived from JID', () => {
    const folder = ensureGroupFolder('120363123456789@g.us', 'mgz');
    // folder should be "mgz-<6hex>"
    expect(folder).toMatch(/^mgz-[0-9a-f]{6}$/);
  });

  it('two groups with identical names get different folders due to JID hash', () => {
    const f1 = ensureGroupFolder('111111111111111@g.us', 'mgz');
    const f2 = ensureGroupFolder('222222222222222@g.us', 'mgz');
    expect(f1).not.toBe(f2);
    // both should be "mgz-<6hex>" but different suffixes
    expect(f1).toMatch(/^mgz-[0-9a-f]{6}$/);
    expect(f2).toMatch(/^mgz-[0-9a-f]{6}$/);
  });

  it('same JID called twice returns same folder (cached in index)', () => {
    const f1 = ensureGroupFolder('111111111111111@g.us', 'mgz');
    const f2 = ensureGroupFolder('111111111111111@g.us', 'different name');
    expect(f1).toBe(f2);
  });

  it('existing index entries from before this change are not migrated', () => {
    // Pre-populate index with an entry in the OLD format (no hash)
    saveGroupIndex({ 'old-group@g.us': { name: 'legacy', folder: 'legacy' } });
    const folder = ensureGroupFolder('old-group@g.us', 'legacy');
    expect(folder).toBe('legacy'); // returned as-is, NOT renamed
  });

  it('hash is deterministic: same JID always produces same 6 chars', () => {
    const jid = '120363999888777@g.us';
    const f1 = ensureGroupFolder(jid, 'alpha');
    // Wipe the index to simulate a second bot instance
    saveGroupIndex({});
    const f2 = ensureGroupFolder(jid, 'alpha');
    expect(f1).toBe(f2);
  });
});
