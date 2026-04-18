import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseCommand, dispatchCommand, normalizeChatKey, type CommandContext } from './commands';

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
