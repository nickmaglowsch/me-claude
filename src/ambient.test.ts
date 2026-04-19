import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  defaultAmbientConfig,
  loadAmbientConfig,
  saveAmbientConfig,
  ensureDailyReset,
  loadMemoryTopics,
  buildTopicBank,
  shouldAmbientReply,
  recordAmbientReply,
  extractVoiceProfileTopics,
  AMBIENT_CONFIG_PATH,
  AmbientConfig,
} from './ambient';
import { _config } from './claude';

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-test-'));
  fs.mkdirSync(path.join(tmpDir, 'data', 'contacts'), { recursive: true });
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: return today's date string "YYYY-MM-DD"
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('loadAmbientConfig', () => {
  it('returns defaults when config file is missing', () => {
    const cfg = loadAmbientConfig();
    const defaults = defaultAmbientConfig();
    expect(cfg.masterEnabled).toBe(defaults.masterEnabled);
    expect(cfg.dailyCap).toBe(defaults.dailyCap);
    expect(cfg.confidenceThreshold).toBe(defaults.confidenceThreshold);
    expect(Array.isArray(cfg.disabledGroups)).toBe(true);
    expect(Array.isArray(cfg.explicitTopics)).toBe(true);
    expect(Array.isArray(cfg.repliesToday)).toBe(true);
  });

  it('returns defaults when file is malformed JSON', () => {
    const cfgPath = path.join(tmpDir, 'data', 'ambient-config.json');
    fs.writeFileSync(cfgPath, 'not valid json', 'utf8');
    const cfg = loadAmbientConfig();
    expect(cfg.masterEnabled).toBe(false);
    expect(cfg.dailyCap).toBe(30);
  });
});

describe('saveAmbientConfig + loadAmbientConfig roundtrip', () => {
  it('saves and loads all fields correctly', () => {
    const cfg: AmbientConfig = {
      masterEnabled: true,
      disabledGroups: ['group a', 'group b'],
      explicitTopics: ['tennis', 'crypto'],
      dailyCap: 10,
      confidenceThreshold: 0.6,
      voiceProfileTopics: ['startups'],
      voiceProfileMtime: 1234567890,
      repliesToday: ['2026-04-17T10:00:00.000Z'],
      lastReset: '2026-04-17',
    };
    saveAmbientConfig(cfg);
    const loaded = loadAmbientConfig();
    expect(loaded).toEqual(cfg);
  });
});

describe('saveAmbientConfig atomic write', () => {
  it('leaves no .tmp- files behind after a successful write', () => {
    saveAmbientConfig(defaultAmbientConfig());
    const dataDir = path.join(tmpDir, 'data');
    const leftovers = fs.readdirSync(dataDir).filter(f => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  // --- safety-net: correct final content when overwriting --------------------
  // Protects task-05 (random tmp naming + O_EXCL) from regressing the overwrite
  // semantics.
  it('second save overwrites first: loadAmbientConfig returns the second config', () => {
    const first: AmbientConfig = {
      ...defaultAmbientConfig(),
      dailyCap: 10,
      explicitTopics: ['tennis'],
    };
    const second: AmbientConfig = {
      ...defaultAmbientConfig(),
      dailyCap: 99,
      explicitTopics: ['crypto', 'startups'],
    };

    saveAmbientConfig(first);
    saveAmbientConfig(second);

    const loaded = loadAmbientConfig();
    expect(loaded.dailyCap).toBe(99);
    expect(loaded.explicitTopics).toEqual(['crypto', 'startups']);
    // First config must be fully replaced
    expect(loaded.explicitTopics).not.toContain('tennis');
    expect(loaded.dailyCap).not.toBe(10);
  });

  it('saveAmbientConfig writes valid JSON that can be parsed independently', () => {
    const cfg: AmbientConfig = {
      ...defaultAmbientConfig(),
      masterEnabled: true,
      dailyCap: 42,
      explicitTopics: ['one', 'two'],
    };
    saveAmbientConfig(cfg);

    const cfgPath = path.join(tmpDir, 'data', 'ambient-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw);
    expect(parsed.masterEnabled).toBe(true);
    expect(parsed.dailyCap).toBe(42);
    expect(parsed.explicitTopics).toEqual(['one', 'two']);
  });
});

describe('ensureDailyReset', () => {
  it('clears repliesToday and updates lastReset when on a new day', () => {
    const cfg: AmbientConfig = {
      ...defaultAmbientConfig(),
      lastReset: '2020-01-01',
      repliesToday: ['2020-01-01T10:00:00.000Z', '2020-01-01T11:00:00.000Z'],
    };
    const updated = ensureDailyReset(cfg);
    expect(updated.repliesToday).toEqual([]);
    expect(updated.lastReset).toBe(today());
  });

  it('is a no-op when lastReset equals today', () => {
    const cfg: AmbientConfig = {
      ...defaultAmbientConfig(),
      lastReset: today(),
      repliesToday: ['2026-04-17T10:00:00.000Z'],
    };
    const updated = ensureDailyReset(cfg);
    expect(updated.repliesToday).toHaveLength(1);
    expect(updated.lastReset).toBe(today());
  });
});

describe('loadMemoryTopics', () => {
  it('parses ## Recurring topics sections from contact files', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'contacts', 'alice@c.us.md'),
      `# Alice\n\n## Identity\n- JID: alice@c.us\n\n## Recurring topics\n- tennis\n- startups\n\n## Raw notes\n- nothing\n`,
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'contacts', 'bob@c.us.md'),
      `# Bob\n\n## Identity\n- JID: bob@c.us\n\n## Recurring topics\n- cooking\n- tennis\n\n## Raw notes\n- nothing\n`,
      'utf8',
    );
    const topics = loadMemoryTopics();
    expect(topics).toContain('tennis');
    expect(topics).toContain('startups');
    expect(topics).toContain('cooking');
    // Deduped: tennis appears only once
    expect(topics.filter(t => t === 'tennis')).toHaveLength(1);
  });

  it('returns empty array when contacts dir is empty', () => {
    // data/contacts exists but is empty
    const topics = loadMemoryTopics();
    expect(topics).toEqual([]);
  });

  it('handles contact files with no ## Recurring topics section', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'contacts', 'charlie@c.us.md'),
      `# Charlie\n\n## Identity\n- JID: charlie@c.us\n\n## Raw notes\n- nothing here\n`,
      'utf8',
    );
    const topics = loadMemoryTopics();
    expect(topics).toEqual([]);
  });
});

describe('buildTopicBank', () => {
  it('merges and dedupes topics from all 3 sources', () => {
    const cfg: AmbientConfig = {
      ...defaultAmbientConfig(),
      explicitTopics: ['a'],
      voiceProfileTopics: ['b'],
    };
    const bank = buildTopicBank(cfg, ['c']);
    expect(bank).toContain('a');
    expect(bank).toContain('b');
    expect(bank).toContain('c');
  });

  it('deduplicates repeated topics across sources', () => {
    const cfg: AmbientConfig = {
      ...defaultAmbientConfig(),
      explicitTopics: ['tennis'],
      voiceProfileTopics: ['tennis'],
    };
    const bank = buildTopicBank(cfg, ['tennis']);
    expect(bank.filter(t => t === 'tennis')).toHaveLength(1);
  });
});

describe('shouldAmbientReply', () => {
  function makeCfg(overrides: Partial<AmbientConfig> = {}): AmbientConfig {
    return { ...defaultAmbientConfig(), masterEnabled: true, ...overrides };
  }

  it('returns pass=false when master is disabled', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg({ masterEnabled: false }),
      chatName: 'group1',
      messageBody: 'I love tennis',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/master/i);
  });

  it('returns pass=false when chat is in disabledGroups', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg({ disabledGroups: ['group1'] }),
      chatName: 'group1',
      messageBody: 'I love tennis',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/group/i);
  });

  it('returns pass=false when daily cap is reached', () => {
    const repliesToday = Array.from({ length: 30 }, (_, i) => `2026-04-17T${String(i).padStart(2, '0')}:00:00.000Z`);
    const result = shouldAmbientReply({
      cfg: makeCfg({ dailyCap: 30, repliesToday }),
      chatName: 'group1',
      messageBody: 'I love tennis',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/cap/i);
  });

  it('returns pass=false when message is too short', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg(),
      chatName: 'group1',
      messageBody: 'ok',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/short/i);
  });

  it('returns pass=false when topic bank is empty', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg(),
      chatName: 'group1',
      messageBody: 'I love tennis',
      topicBank: [],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/topic/i);
  });

  it('returns pass=false when no fuzzy match is found', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg({ confidenceThreshold: 0.9 }),
      chatName: 'group1',
      messageBody: 'random unrelated message here',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/match/i);
  });

  it('returns pass=true with matchedTopic and score on a hit', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg({ confidenceThreshold: 0.5 }),
      chatName: 'group1',
      messageBody: 'watched tennis yesterday',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(true);
    expect(result.reason).toMatch(/match/i);
    expect(result.matchedTopic).toBe('tennis');
    expect(typeof result.score).toBe('number');
  });

  it('normalizes chatName for disabledGroups comparison', () => {
    const result = shouldAmbientReply({
      cfg: makeCfg({ disabledGroups: ['my group'] }),
      chatName: 'My Group',
      messageBody: 'I love tennis',
      topicBank: ['tennis'],
    });
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/group/i);
  });
});

describe('recordAmbientReply', () => {
  it('appends a timestamp to repliesToday', () => {
    const cfg = defaultAmbientConfig();
    const updated = recordAmbientReply(cfg);
    expect(updated.repliesToday).toHaveLength(1);
    expect(typeof updated.repliesToday[0]).toBe('string');
    // Should be a valid ISO timestamp
    expect(() => new Date(updated.repliesToday[0])).not.toThrow();
  });

  it('triggers daily reset if lastReset is an old date', () => {
    const cfg: AmbientConfig = {
      ...defaultAmbientConfig(),
      lastReset: '2020-01-01',
      repliesToday: ['2020-01-01T10:00:00.000Z'],
    };
    const updated = recordAmbientReply(cfg);
    // Old entry is cleared, only the new timestamp is present
    expect(updated.repliesToday).toHaveLength(1);
    expect(updated.lastReset).toBe(today());
  });
});

// ---- extractVoiceProfileTopics tests ----------------------------------------
// These tests stub `_config.command` / `_config.args` to use node as a fake
// claude binary, identical to how claude.test.ts does it.

describe('extractVoiceProfileTopics', () => {
  let originalCommand: string;
  let originalArgs: string[];

  beforeEach(() => {
    originalCommand = _config.command;
    originalArgs = [..._config.args];
    // Point at node so we can script deterministic output via -e
    _config.command = 'node';
  });

  afterEach(() => {
    _config.command = originalCommand;
    _config.args = originalArgs;
  });

  // Test 17: parses multi-line output — stub outputs "a\nb\nc" → returns ["a","b","c"]
  it('parses newline-separated output into topic array', async () => {
    // Node script: read stdin (the prompt), write fixed topics to stdout
    _config.args = ['-e', "process.stdin.resume(); process.stdin.on('data', () => {}); process.stdout.write('a\\nb\\nc');"];
    // Write a fake voice profile file so the function doesn't return [] early
    const vpPath = path.join(tmpDir, 'data', 'voice_profile.md');
    fs.mkdirSync(path.dirname(vpPath), { recursive: true });
    fs.writeFileSync(vpPath, 'fake voice profile', 'utf8');
    const topics = await extractVoiceProfileTopics(vpPath);
    expect(topics).toEqual(['a', 'b', 'c']);
  });

  // Test 18: dedupes — stub outputs "a\nA\na" → returns ["a"]
  it('deduplicates topics (case-insensitive — lowercases first)', async () => {
    _config.args = ['-e', "process.stdin.resume(); process.stdin.on('data', () => {}); process.stdout.write('a\\nA\\na');"];
    const vpPath = path.join(tmpDir, 'data', 'voice_profile.md');
    fs.writeFileSync(vpPath, 'fake voice profile', 'utf8');
    const topics = await extractVoiceProfileTopics(vpPath);
    expect(topics).toEqual(['a']);
  });

  // Test 19: caps at 20 lines
  it('caps the returned list at 20 topics', async () => {
    // Output 25 unique topics
    const twentyFive = Array.from({ length: 25 }, (_, i) => `topic${i}`).join('\\n');
    _config.args = ['-e', `process.stdin.resume(); process.stdin.on('data', () => {}); process.stdout.write('${twentyFive}');`];
    const vpPath = path.join(tmpDir, 'data', 'voice_profile.md');
    fs.writeFileSync(vpPath, 'fake voice profile', 'utf8');
    const topics = await extractVoiceProfileTopics(vpPath);
    expect(topics.length).toBeLessThanOrEqual(20);
  });

  // Test 20: returns [] when file missing
  it('returns [] when voice profile file does not exist', async () => {
    const missingPath = path.join(tmpDir, 'data', 'nonexistent_profile.md');
    const topics = await extractVoiceProfileTopics(missingPath);
    expect(topics).toEqual([]);
  });

  // Test 21: returns [] when claude fails (stub exits 1)
  it('returns [] (and does not throw) when claude subprocess exits non-zero', async () => {
    _config.args = ['-e', 'process.exit(1);'];
    const vpPath = path.join(tmpDir, 'data', 'voice_profile.md');
    fs.writeFileSync(vpPath, 'fake voice profile', 'utf8');
    const topics = await extractVoiceProfileTopics(vpPath);
    expect(topics).toEqual([]);
  });
});

// ---- loadAmbientConfig schema validation ------------------------------------

describe('loadAmbientConfig schema validation', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-schema-test-'));
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown): void {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'ambient-config.json'),
      JSON.stringify(obj),
      'utf8',
    );
  }

  it('valid config loads correctly', () => {
    writeConfig({
      masterEnabled: true,
      disabledGroups: ['chat-a'],
      explicitTopics: ['football'],
      dailyCap: 20,
      confidenceThreshold: 0.6,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.explicitTopics).toEqual(['football']);
  });

  it('missing masterEnabled field → returns defaultAmbientConfig', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({ disabledGroups: [], explicitTopics: [] }); // masterEnabled missing
    const cfg = loadAmbientConfig();
    expect(cfg).toEqual(defaultAmbientConfig());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('masterEnabled is string instead of boolean → returns defaultAmbientConfig', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({
      masterEnabled: 'yes',  // wrong type
      disabledGroups: [],
      explicitTopics: [],
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg).toEqual(defaultAmbientConfig());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('explicitTopics is not an array → returns defaultAmbientConfig', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: 'football',  // should be array
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg).toEqual(defaultAmbientConfig());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('explicitTopics longer than 200 entries → truncated to 200 with warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bigBank = Array.from({ length: 205 }, (_, i) => `topic-${i}`);
    writeConfig({
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: bigBank,
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg.explicitTopics).toHaveLength(200);
    expect(cfg.explicitTopics[0]).toBe('topic-0');
    expect(cfg.explicitTopics[199]).toBe('topic-199');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('explicitTopics entry longer than 64 chars → dropped at load time', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longPhrase = 'x'.repeat(65);
    writeConfig({
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: ['ok', longPhrase, 'also-ok'],
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg.explicitTopics).toEqual(['ok', 'also-ok']);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('explicitTopics at the caps (200 entries, 64 chars each) passes through untouched', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const maxPhrase = 'y'.repeat(64);
    const bank = Array.from({ length: 200 }, () => maxPhrase);
    writeConfig({
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: bank,
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg.explicitTopics).toHaveLength(200);
    expect(cfg.explicitTopics.every(t => t === maxPhrase)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
