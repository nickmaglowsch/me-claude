import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseCommand, dispatchCommand, normalizeChatKey, parseDateSpec, type CommandContext } from './commands';
import { _config } from './claude';
import { ensureGroupFolder, persistMessage, localDate } from './groups';

// ---- Helpers ----------------------------------------------------------------

function makeTmpContactsDir(): { tmpDir: string; contactsDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-test-'));
  const contactsDir = path.join(tmpDir, 'data', 'contacts');
  fs.mkdirSync(contactsDir, { recursive: true });
  return { tmpDir, contactsDir };
}

function makeTmpEventsDir(): { tmpDir: string; eventsFile: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-test-events-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  const eventsFile = path.join(tmpDir, 'data', 'events.jsonl');
  return { tmpDir, eventsFile };
}

function makeCtx(
  replies: string[],
  silences: Map<string, number>,
  overrides?: Partial<CommandContext>,
): CommandContext {
  return {
    ownerCusId: 'owner@c.us',
    reply: async (text: string) => { replies.push(text); },
    silences,
    ...overrides,
  };
}

// ---- parseCommand -----------------------------------------------------------

describe('parseCommand', () => {
  it('plain command: !help returns correct ParsedCommand', () => {
    const result = parseCommand('!help');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('help');
    expect(result!.argv).toEqual([]);
    expect(result!.raw).toBe('help');
  });

  it('command with args: !remember jid1 some fact', () => {
    const result = parseCommand('!remember jid1 some fact');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('remember');
    expect(result!.argv).toEqual(['jid1', 'some', 'fact']);
    expect(result!.raw).toBe('remember jid1 some fact');
  });

  it('command with extra whitespace: trims and parses', () => {
    // After trimming, leading ! is still there → should parse
    const result = parseCommand('  !help  ');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('help');
  });

  it('no bang: returns null', () => {
    expect(parseCommand('help')).toBeNull();
  });

  it('only bang: returns null (no command name)', () => {
    expect(parseCommand('!')).toBeNull();
  });

  it('empty string: returns null', () => {
    expect(parseCommand('')).toBeNull();
  });
});

// ---- dispatchCommand --------------------------------------------------------

describe('dispatchCommand — !help', () => {
  it('lists all expected commands', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!help')!, ctx);
    const text = replies.join('\n');
    expect(text).toContain('!remember');
    expect(text).toContain('!forget');
    expect(text).toContain('!who');
    expect(text).toContain('!status');
    expect(text).toContain('!silence');
    expect(text).toContain('!resume');
  });
});

describe('dispatchCommand — unknown command', () => {
  it('replies with unknown command message', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!asdf')!, ctx);
    expect(replies[0]).toContain('unknown command: asdf');
  });
});

describe('dispatchCommand — !remember', () => {
  let tmpDir: string;
  let contactsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    ({ tmpDir, contactsDir } = makeTmpContactsDir());
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: appends fact to existing file and confirms', async () => {
    const jid = 'test1@c.us';
    const filePath = path.join(contactsDir, `${jid}.md`);
    fs.writeFileSync(
      filePath,
      '## Identity\n\nTest Person\n\n## Facts\n\n- existing fact\n',
      'utf8',
    );

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand(`!remember ${jid} new fact about them`)!, ctx);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('new fact about them');
    expect(replies[0]).toContain('remembered');
  });

  it('creates file if missing with minimal template', async () => {
    const jid = 'brand-new@c.us';
    const filePath = path.join(contactsDir, `${jid}.md`);
    expect(fs.existsSync(filePath)).toBe(false);

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand(`!remember ${jid} they like cats`)!, ctx);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('they like cats');
    expect(replies[0]).toContain('remembered');
  });
});

describe('dispatchCommand — !forget', () => {
  let tmpDir: string;
  let contactsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    ({ tmpDir, contactsDir } = makeTmpContactsDir());
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: deletes file and confirms', async () => {
    const jid = 'delete-me@c.us';
    const filePath = path.join(contactsDir, `${jid}.md`);
    fs.writeFileSync(filePath, '## Identity\nSomeone\n', 'utf8');

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand(`!forget ${jid}`)!, ctx);

    expect(fs.existsSync(filePath)).toBe(false);
    expect(replies[0]).toContain('forgot');
    expect(replies[0]).toContain(jid);
  });

  it('missing file: replies with no file message', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!forget ghost@c.us')!, ctx);
    expect(replies[0]).toContain('no file');
    expect(replies[0]).toContain('ghost@c.us');
  });
});

describe('dispatchCommand — !who', () => {
  let tmpDir: string;
  let contactsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    ({ tmpDir, contactsDir } = makeTmpContactsDir());
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('with jid returns file contents', async () => {
    const jid = 'known@c.us';
    fs.writeFileSync(
      path.join(contactsDir, `${jid}.md`),
      'hello world\n',
      'utf8',
    );

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand(`!who ${jid}`)!, ctx);
    expect(replies[0]).toContain('hello world');
  });

  it('with missing jid replies no memory', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!who nobody@c.us')!, ctx);
    expect(replies[0]).toMatch(/no memory/i);
  });

  it('with name resolves via grep: 1 match returns file contents', async () => {
    const jid = 'alice-contact@c.us';
    fs.writeFileSync(
      path.join(contactsDir, `${jid}.md`),
      '## Identity\n\nAlice Smith\n',
      'utf8',
    );

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!who Alice')!, ctx);
    expect(replies[0]).toContain('Alice Smith');
  });

  it('with ambiguous name: two files match → reply lists candidates', async () => {
    fs.writeFileSync(
      path.join(contactsDir, 'alice1@c.us.md'),
      '## Identity\n\nAlice One\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(contactsDir, 'alice2@c.us.md'),
      '## Identity\n\nAlice Two\n',
      'utf8',
    );

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!who Alice')!, ctx);
    // Should mention multiple matches and list them
    const text = replies[0];
    expect(text).toMatch(/multiple|ambiguous|matches/i);
    expect(text).toContain('alice1@c.us');
    expect(text).toContain('alice2@c.us');
  });
});

describe('dispatchCommand — !status', () => {
  let tmpDir: string;
  let eventsFile: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    ({ tmpDir, eventsFile } = makeTmpEventsDir());
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('empty events.jsonl returns zeroed summary', async () => {
    fs.writeFileSync(eventsFile, '', 'utf8');

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!status')!, ctx);
    const text = replies[0];
    expect(text).toContain('0');
  });

  it('with 3 reply.sent events: reply mentions "3 replies"', async () => {
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({ ts: now, kind: 'reply.sent', chat: 'grp1', trigger: 'mention', duration_ms: 1000 }),
      JSON.stringify({ ts: now, kind: 'reply.sent', chat: 'grp1', trigger: 'mention', duration_ms: 1500 }),
      JSON.stringify({ ts: now, kind: 'reply.sent', chat: 'grp2', trigger: 'reply', duration_ms: 2000 }),
    ].join('\n') + '\n';
    fs.writeFileSync(eventsFile, lines, 'utf8');

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!status')!, ctx);
    const text = replies[0];
    // formatStats outputs "Replies: 3" (capital R, number after colon)
    expect(text).toMatch(/replies:\s*3/i);
  });
});

describe('dispatchCommand — !silence', () => {
  it('parses 2h duration and sets silences map', async () => {
    const silences = new Map<string, number>();
    const replies: string[] = [];
    const ctx = makeCtx(replies, silences);
    const before = Date.now();
    await dispatchCommand(parseCommand('!silence mgz 2h')!, ctx);
    const after = Date.now();

    const muteUntil = silences.get('mgz')!;
    expect(muteUntil).toBeDefined();
    // Should be ~2h in the future (within a second of before+2h)
    const twoHoursMs = 2 * 60 * 60 * 1000;
    expect(muteUntil).toBeGreaterThanOrEqual(before + twoHoursMs - 100);
    expect(muteUntil).toBeLessThanOrEqual(after + twoHoursMs + 100);
    expect(replies[0]).toContain('silenced');
    expect(replies[0]).toContain('mgz');
  });

  it('silence all sets "*" key in silences map', async () => {
    const silences = new Map<string, number>();
    const replies: string[] = [];
    const ctx = makeCtx(replies, silences);
    const before = Date.now();
    await dispatchCommand(parseCommand('!silence all 1h')!, ctx);
    const after = Date.now();

    const muteUntil = silences.get('*')!;
    expect(muteUntil).toBeDefined();
    const oneHourMs = 60 * 60 * 1000;
    expect(muteUntil).toBeGreaterThanOrEqual(before + oneHourMs - 100);
    expect(muteUntil).toBeLessThanOrEqual(after + oneHourMs + 100);
  });
});

describe('normalizeChatKey', () => {
  it('lowercases the input', () => {
    expect(normalizeChatKey('MGZ')).toBe('mgz');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeChatKey('  mgz  ')).toBe('mgz');
  });

  it('lowercases and trims together', () => {
    expect(normalizeChatKey('  My Group  ')).toBe('my group');
  });
});

describe('dispatchCommand — !silence key normalization', () => {
  it('stores key in lowercase so a lookup with the original case still matches', async () => {
    const silences = new Map<string, number>();
    const replies: string[] = [];
    const ctx = makeCtx(replies, silences);
    // User types uppercase chat name
    await dispatchCommand(parseCommand('!silence MGZ 2h')!, ctx);
    // Key must be stored normalized (lowercase)
    expect(silences.has('mgz')).toBe(true);
    expect(silences.has('MGZ')).toBe(false);
    expect(replies[0]).toContain('silenced');
    // Reply shows original input for readability
    expect(replies[0]).toContain('MGZ');
  });

  it('silencing with mixed-case and looking up via normalizeChatKey on same name both resolve', async () => {
    const silences = new Map<string, number>();
    const replies: string[] = [];
    const ctx = makeCtx(replies, silences);
    // Store using uppercase arg
    await dispatchCommand(parseCommand('!silence MGZ 2h')!, ctx);
    // Simulating index.ts lookup: normalizeChatKey applied to chat.name
    const lookupKey = normalizeChatKey('MGZ');
    expect(silences.has(lookupKey)).toBe(true);
    // Also verify the lowercase variant matches (as index.ts would use)
    const lookupKeyLower = normalizeChatKey('mgz');
    expect(silences.has(lookupKeyLower)).toBe(true);
  });
});

describe('dispatchCommand — !resume', () => {
  it('clears all silences', async () => {
    const silences = new Map<string, number>([
      ['mgz', Date.now() + 99999],
      ['*', Date.now() + 99999],
    ]);
    const replies: string[] = [];
    const ctx = makeCtx(replies, silences);
    await dispatchCommand(parseCommand('!resume')!, ctx);
    expect(silences.size).toBe(0);
    expect(replies[0]).toContain('resumed');
  });
});

// ---- !ambient + !topic tests ------------------------------------------------
// These commands read/write ambient-config.json in data/, so we need a tmp cwd.

describe('dispatchCommand — !ambient and !topic', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-ambient-test-'));
    fs.mkdirSync(path.join(tmpDir, 'data', 'contacts'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to read the persisted config
  function loadCfg() {
    const cfgPath = path.join(tmpDir, 'data', 'ambient-config.json');
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }

  // Test 1: !ambient on — sets masterEnabled=true, persists, reply mentions "on"
  it('!ambient on sets masterEnabled=true and confirms', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient on')!, ctx);
    const cfg = loadCfg();
    expect(cfg.masterEnabled).toBe(true);
    expect(replies[0]).toMatch(/on/i);
    expect(replies[0]).toMatch(/ambient/i);
  });

  // Test 2: !ambient off — sets masterEnabled=false
  it('!ambient off sets masterEnabled=false and confirms', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient off')!, ctx);
    const cfg = loadCfg();
    expect(cfg.masterEnabled).toBe(false);
    expect(replies[0]).toMatch(/off/i);
  });

  // Test 3: !ambient off mgz — adds "mgz" to disabledGroups
  it('!ambient off <chat> adds chat to disabledGroups', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient off mgz')!, ctx);
    const cfg = loadCfg();
    expect(cfg.disabledGroups).toContain('mgz');
    expect(replies[0]).toMatch(/disabled/i);
    expect(replies[0]).toContain('mgz');
  });

  // Test 4: !ambient off MGZ — normalizes to "mgz"
  it('!ambient off <CHAT> normalizes chat name to lowercase', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient off MGZ')!, ctx);
    const cfg = loadCfg();
    expect(cfg.disabledGroups).toContain('mgz');
    expect(cfg.disabledGroups).not.toContain('MGZ');
  });

  // Test 5: !ambient on mgz — removes from disabledGroups
  it('!ambient on <chat> removes chat from disabledGroups', async () => {
    // First disable it
    const replies1: string[] = [];
    await dispatchCommand(parseCommand('!ambient off mgz')!, makeCtx(replies1, new Map()));
    // Then re-enable it
    const replies2: string[] = [];
    const ctx = makeCtx(replies2, new Map());
    await dispatchCommand(parseCommand('!ambient on mgz')!, ctx);
    const cfg = loadCfg();
    expect(cfg.disabledGroups).not.toContain('mgz');
    expect(replies2[0]).toMatch(/re-enabled|enabled/i);
    expect(replies2[0]).toContain('mgz');
  });

  // Test 6: !ambient status — includes master state, topic count, cap, threshold
  it('!ambient status includes master state, cap, threshold, and non-negative topic counts', async () => {
    // Add an explicit topic and a voice topic that overlap to verify arithmetic is correct
    await dispatchCommand(parseCommand('!topic add tennis')!, makeCtx([], new Map()));
    // Simulate overlapping voice topic by writing config directly
    const cfgPath = path.join(tmpDir, 'data', 'ambient-config.json');
    const existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath, JSON.stringify({ ...existing, voiceProfileTopics: ['tennis', 'startups'] }), 'utf8');

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient status')!, ctx);
    const text = replies[0];
    expect(text).toMatch(/master/i);
    expect(text).toMatch(/cap/i);
    expect(text).toMatch(/threshold/i);
    // New format: "topics: explicit=N voice=N memory=N bank=N"
    expect(text).toMatch(/topics:/i);
    expect(text).toMatch(/explicit=\d+/);
    expect(text).toMatch(/voice=\d+/);
    expect(text).toMatch(/memory=\d+/);
    expect(text).toMatch(/bank=\d+/);
    // With explicit=["tennis"] and voice=["tennis","startups"], bank dedupes to 2.
    // The old formula would yield 2 - 1 - 2 = -1; the new one should give memory=0.
    expect(text).toContain('explicit=1');
    expect(text).toContain('voice=2');
    expect(text).toContain('memory=0');
    expect(text).toContain('bank=2');
  });

  // Test 7: !ambient cap 50 — sets dailyCap
  it('!ambient cap <n> sets dailyCap', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient cap 50')!, ctx);
    const cfg = loadCfg();
    expect(cfg.dailyCap).toBe(50);
    expect(replies[0]).toMatch(/50/);
    expect(replies[0]).toMatch(/cap/i);
  });

  // Test 8: !ambient cap abc — validation error; cap unchanged
  it('!ambient cap <non-int> replies with validation error and leaves cap unchanged', async () => {
    // Set a known cap first
    await dispatchCommand(parseCommand('!ambient cap 42')!, makeCtx([], new Map()));
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient cap abc')!, ctx);
    expect(replies[0]).toMatch(/invalid|error|positive/i);
    const cfg = loadCfg();
    expect(cfg.dailyCap).toBe(42);
  });

  // Test 9: !ambient threshold 0.7 — sets confidenceThreshold
  it('!ambient threshold <n> sets confidenceThreshold', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient threshold 0.7')!, ctx);
    const cfg = loadCfg();
    expect(cfg.confidenceThreshold).toBeCloseTo(0.7);
    expect(replies[0]).toMatch(/threshold/i);
    expect(replies[0]).toMatch(/0\.7/);
  });

  // Test 10: !ambient threshold 2 — validation error (out of 0-1 range)
  it('!ambient threshold <out-of-range> replies with validation error', async () => {
    // First establish a known config with a valid threshold (0.5 = default)
    await dispatchCommand(parseCommand('!ambient threshold 0.5')!, makeCtx([], new Map()));
    // Now attempt an invalid one
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!ambient threshold 2')!, ctx);
    expect(replies[0]).toMatch(/invalid|error|range|0.*1/i);
    const cfg = loadCfg();
    // Unchanged from the valid one set above
    expect(cfg.confidenceThreshold).toBeCloseTo(0.5);
  });

  // Test 11: !topic add tennis — appends to explicitTopics
  it('!topic add <phrase> appends to explicitTopics', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic add tennis')!, ctx);
    const cfg = loadCfg();
    expect(cfg.explicitTopics).toContain('tennis');
    expect(replies[0]).toMatch(/added/i);
    expect(replies[0]).toContain('tennis');
  });

  // Test 12: !topic add TENNIS — normalizes to "tennis"
  it('!topic add <PHRASE> normalizes to lowercase', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic add TENNIS')!, ctx);
    const cfg = loadCfg();
    expect(cfg.explicitTopics).toContain('tennis');
    expect(cfg.explicitTopics).not.toContain('TENNIS');
  });

  // Test 13: !topic add tennis (second time) — no duplicate, reply says "already in list"
  it('!topic add duplicate phrase does not add it twice and replies "already in list"', async () => {
    await dispatchCommand(parseCommand('!topic add tennis')!, makeCtx([], new Map()));
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic add tennis')!, ctx);
    const cfg = loadCfg();
    expect(cfg.explicitTopics.filter((t: string) => t === 'tennis')).toHaveLength(1);
    expect(replies[0]).toMatch(/already in list/i);
    expect(replies[0]).toContain('tennis');
  });

  // Test 14: !topic remove tennis — removes from list
  it('!topic remove <phrase> removes from explicitTopics', async () => {
    await dispatchCommand(parseCommand('!topic add tennis')!, makeCtx([], new Map()));
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic remove tennis')!, ctx);
    const cfg = loadCfg();
    expect(cfg.explicitTopics).not.toContain('tennis');
    expect(replies[0]).toMatch(/removed/i);
  });

  // Test 15: !topic remove nonexistent — reply indicates not found
  it('!topic remove <nonexistent> replies with not found message', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic remove ghost')!, ctx);
    expect(replies[0]).toMatch(/not in list|not found/i);
  });

  // Test 16: !topic list — replies with all 3 sources
  it('!topic list replies with all 3 topic sources', async () => {
    // Add an explicit topic
    await dispatchCommand(parseCommand('!topic add crypto')!, makeCtx([], new Map()));
    // Add a contact file with a recurring topic
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'contacts', 'alice@c.us.md'),
      `# Alice\n\n## Recurring topics\n- startups\n`,
      'utf8',
    );

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic list')!, ctx);
    const text = replies[0];
    expect(text).toMatch(/explicit/i);
    expect(text).toContain('crypto');
    expect(text).toMatch(/memory/i);
    expect(text).toContain('startups');
  });
});

// ---- dispatchCommand — !topic add validation --------------------------------

describe('dispatchCommand — !topic add validation', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-test-'));
    // Create the data dir so saveAmbientConfig can write
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('!topic add phrase > 64 chars is rejected with error reply', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    const longPhrase = 'a'.repeat(65);
    await dispatchCommand(parseCommand(`!topic add ${longPhrase}`)!, ctx);
    expect(replies[0]).toMatch(/too long|64/i);
  });

  it('!topic add accepts phrase exactly 64 chars', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    const exactPhrase = 'a'.repeat(64);
    await dispatchCommand(parseCommand(`!topic add ${exactPhrase}`)!, ctx);
    expect(replies[0]).toMatch(/^ok, added/);
  });

  it('!topic add is rejected when bank has 200 entries', async () => {
    // Pre-populate ambient config with 200 explicit topics
    const cfg = {
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: Array.from({ length: 200 }, (_, i) => `topic-${i}`),
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'ambient-config.json'),
      JSON.stringify(cfg, null, 2),
      'utf8',
    );
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic add new-topic')!, ctx);
    expect(replies[0]).toMatch(/limit|200|full/i);
  });
});

// ---- parseDateSpec ----------------------------------------------------------

describe('parseDateSpec', () => {
  it('returns today for "today"', () => {
    const expected = localDate(Date.now());
    expect(parseDateSpec('today')).toBe(expected);
  });

  it('returns today for undefined', () => {
    const expected = localDate(Date.now());
    expect(parseDateSpec(undefined)).toBe(expected);
  });

  it('returns today for empty string', () => {
    const expected = localDate(Date.now());
    expect(parseDateSpec('')).toBe(expected);
  });

  it('returns yesterday for "yesterday"', () => {
    const yesterdayMs = Date.now() - 24 * 60 * 60 * 1000;
    const expected = localDate(yesterdayMs);
    expect(parseDateSpec('yesterday')).toBe(expected);
  });

  it('returns 3 days ago for "3d"', () => {
    const ms = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const expected = localDate(ms);
    expect(parseDateSpec('3d')).toBe(expected);
  });

  it('returns exact date for YYYY-MM-DD format', () => {
    expect(parseDateSpec('2026-04-15')).toBe('2026-04-15');
  });

  it('returns null for unrecognized format', () => {
    expect(parseDateSpec('not-a-date')).toBeNull();
  });
});

// ---- dispatchCommand — !summary ---------------------------------------------

describe('dispatchCommand — !summary', () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalCommand: string;
  let originalArgs: string[];

  beforeEach(() => {
    originalCwd = process.cwd();
    originalCommand = _config.command;
    originalArgs = [..._config.args];

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commands-summary-test-'));
    // Set up directory structure required by groups and events
    fs.mkdirSync(path.join(tmpDir, 'data', 'contacts'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'data', 'groups'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    _config.command = originalCommand;
    _config.args = originalArgs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: write a group with messages into the temp cwd
  function seedGroup(groupName: string, jid: string, date: string, messages: Array<{ from_name: string; body: string; from_me?: boolean }>) {
    ensureGroupFolder(jid, groupName);
    for (const m of messages) {
      const tsMs = new Date(`${date}T12:00:00.000Z`).getTime();
      persistMessage({
        chatJid: jid,
        chatName: groupName,
        msg: {
          ts: new Date(tsMs).toISOString(),
          local_date: date,
          from_jid: m.from_me ? '' : `${m.from_name.toLowerCase()}@c.us`,
          from_name: m.from_name,
          body: m.body,
          from_me: !!m.from_me,
          type: 'chat',
          id: `id-${Math.random()}`,
          has_quoted: false,
          quoted_id: null,
        },
      });
    }
  }

  // Test 7: !summary with no args → reply contains "usage" or "missing"
  it('!summary with no args replies with usage hint', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary')!, ctx);
    expect(replies[0]).toMatch(/usage|missing/i);
  });

  // Test 8: !summary <non-existent> → reply "no group matching ..."
  it('!summary <non-existent> replies "no group matching"', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary asdfxyz')!, ctx);
    expect(replies[0]).toMatch(/no group matching/i);
  });

  // Test 9: !summary <ambiguous> → reply lists both groups
  it('!summary <ambiguous> with two matching groups lists candidates', async () => {
    // Use group names that score >= 0.4 with the query "chat"
    // diceSimilarity("chat", "chat alpha") ≈ 0.5, ("chat", "chat beta") ≈ 0.55
    ensureGroupFolder('111@g.us', 'chat alpha');
    ensureGroupFolder('222@g.us', 'chat beta');

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary chat')!, ctx);
    // Both groups should be listed or reply should indicate multiple matches
    expect(replies[0]).toMatch(/multiple|ambiguous|matches/i);
    expect(replies[0]).toMatch(/chat alpha|chat beta/i);
  });

  // Test 10: !summary mgz with empty JSONL → reply "no messages for mgz on <today>"
  it('!summary with empty JSONL for today replies "no messages"', async () => {
    ensureGroupFolder('mgz-test@g.us', 'mgz');

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary mgz')!, ctx);
    expect(replies[0]).toMatch(/no messages/i);
  });

  // Test 11: !summary mgz with 2 messages — stub echoes stdin so we can verify
  // prompt construction: [HH:MM] Name: body lines must be present, (me) suffix
  // for fromMe messages must appear. A regression in message formatting or the
  // (me) annotation will make this test fail.
  it('!summary with messages uses claude and returns summary with correct prompt formatting', async () => {
    const today = localDate(Date.now());
    seedGroup('mgz', 'mgz-jid@g.us', today, [
      { from_name: 'Alice', body: 'first body' },
      { from_name: 'Nick', body: 'second body', from_me: true },
    ]);

    // Stub claude to echo its stdin back as output so we can inspect the prompt
    _config.command = 'node';
    _config.args = ['-e', `
      let buf = '';
      process.stdin.on('data', c => buf += c);
      process.stdin.on('end', () => process.stdout.write(buf));
    `];

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary mgz')!, ctx);
    const reply = replies[0];
    // Verify the [HH:MM] Name: body structure for the non-fromMe message
    expect(reply).toMatch(/\[\d{2}:\d{2}\] Alice: first body/);
    // Verify the (me) marker is present for Nick's fromMe message
    expect(reply).toMatch(/\[\d{2}:\d{2}\] Nick: second body \(me\)/);
  });

  // Test 12: !summary mgz yesterday reads yesterday's file (not today's)
  it('!summary mgz yesterday reads yesterday file', async () => {
    const yesterday = localDate(Date.now() - 24 * 60 * 60 * 1000);
    seedGroup('mgz', 'mgz-jid@g.us', yesterday, [
      { from_name: 'Alice', body: 'yesterday message' },
    ]);

    _config.command = 'node';
    _config.args = ['-e', 'process.stdin.on("data",()=>{}); process.stdin.on("end", ()=> console.log("YesterdaySummary"))'];

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary mgz yesterday')!, ctx);
    expect(replies[0]).toContain('YesterdaySummary');
  });

  // Test 13: !summary mgz 2d reads file from 2 days ago
  it('!summary mgz 2d reads file from 2 days ago', async () => {
    const twoDaysAgo = localDate(Date.now() - 2 * 24 * 60 * 60 * 1000);
    seedGroup('mgz', 'mgz-jid@g.us', twoDaysAgo, [
      { from_name: 'Alice', body: '2d message' },
    ]);

    _config.command = 'node';
    _config.args = ['-e', 'process.stdin.on("data",()=>{}); process.stdin.on("end", ()=> console.log("TwoDaysSummary"))'];

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary mgz 2d')!, ctx);
    expect(replies[0]).toContain('TwoDaysSummary');
  });

  // Test 14: !summary mgz 2026-04-15 reads that exact date's file
  it('!summary mgz 2026-04-15 reads that exact date', async () => {
    seedGroup('mgz', 'mgz-jid@g.us', '2026-04-15', [
      { from_name: 'Alice', body: 'April 15 message' },
    ]);

    _config.command = 'node';
    _config.args = ['-e', 'process.stdin.on("data",()=>{}); process.stdin.on("end", ()=> console.log("AprilSummary"))'];

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary mgz 2026-04-15')!, ctx);
    expect(replies[0]).toContain('AprilSummary');
  });

  // Test 15: !summary mgz when claude subprocess errors → reply contains "summary failed"
  it('!summary when claude errors replies "summary failed"', async () => {
    const today = localDate(Date.now());
    seedGroup('mgz', 'mgz-jid@g.us', today, [
      { from_name: 'Alice', body: 'a message' },
    ]);

    // Make claude exit with non-zero code
    _config.command = 'node';
    _config.args = ['-e', 'process.exit(1)'];

    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!summary mgz')!, ctx);
    expect(replies[0]).toMatch(/summary failed/i);
  });
});
