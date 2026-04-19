import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  extractFeedbackTopics,
  loadFeedbackTopics,
  saveFeedbackTopics,
  maybeRefreshFeedbackTopics,
} from './feedback-topics';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper: write a JSONL file for a group
function writeGroupFile(groupName: string, date: string, lines: object[]): void {
  const dir = path.join(tmpDir, 'data', 'groups', groupName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.jsonl`);
  const content = lines.map(l => JSON.stringify(l)).join('\n');
  fs.writeFileSync(file, content, 'utf8');
}

describe('extractFeedbackTopics', () => {
  it('returns [] when data/groups directory does not exist', () => {
    const result = extractFeedbackTopics({ bank: [] });
    expect(result).toEqual([]);
  });

  it('tokenizes and counts tokens across multiple JSONL days', () => {
    // Write two JSONL files. Nick replies in each, preceded by messages
    // that contain "futebol" repeatedly.
    const msg1 = { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'futebol futebol hoje' };
    const msg2 = { ts: '2024-01-01T10:01:00.000Z', from_me: false, body: 'assistindo futebol agora' };
    const nick1 = { ts: '2024-01-01T10:02:00.000Z', from_me: true, body: 'sim futebol top' };

    const msg3 = { ts: '2024-01-02T15:00:00.000Z', from_me: false, body: 'futebol ontem foi incrivel' };
    const nick2 = { ts: '2024-01-02T15:01:00.000Z', from_me: true, body: 'concordo muito bom' };

    writeGroupFile('group1', '2024-01-01', [msg1, msg2, nick1]);
    writeGroupFile('group1', '2024-01-02', [msg3, nick2]);

    const result = extractFeedbackTopics({ bank: [] });
    expect(result).toContain('futebol');
  });

  it('drops stopwords (e.g. "the", "de", "para")', () => {
    // Messages with only stopwords before Nick's reply
    const stopMsg = { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'the de para com uma por' };
    const nick = { ts: '2024-01-01T10:01:00.000Z', from_me: true, body: 'ok' };
    // Add 3 occurrences worth of stopwords by padding the body
    writeGroupFile('group1', '2024-01-01', [
      { ...stopMsg, ts: '2024-01-01T10:00:00.000Z' },
      { ...stopMsg, ts: '2024-01-01T10:00:30.000Z' },
      { ...stopMsg, ts: '2024-01-01T10:01:00.000Z' },
      nick,
    ]);
    const result = extractFeedbackTopics({ bank: [] });
    expect(result).not.toContain('the');
    expect(result).not.toContain('de');
    expect(result).not.toContain('para');
  });

  it('drops tokens already in bank', () => {
    const bank = ['futebol'];
    // Enough occurrences to exceed minCount
    const msg = { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'futebol futebol futebol' };
    const nick = { ts: '2024-01-01T10:01:00.000Z', from_me: true, body: 'sim' };
    writeGroupFile('group1', '2024-01-01', [msg, nick]);
    const result = extractFeedbackTopics({ bank });
    expect(result).not.toContain('futebol');
  });

  it('drops pure-digit tokens (phone number in message body)', () => {
    // 3 messages before Nick's reply containing phone numbers
    const phoneMsg = (ts: string) => ({ ts, from_me: false, body: '11987654321 ligue 11987654321 ja 11987654321' });
    const nick = { ts: '2024-01-01T10:04:00.000Z', from_me: true, body: 'ok' };
    writeGroupFile('group1', '2024-01-01', [
      phoneMsg('2024-01-01T10:00:00.000Z'),
      phoneMsg('2024-01-01T10:01:00.000Z'),
      phoneMsg('2024-01-01T10:02:00.000Z'),
      nick,
    ]);
    const result = extractFeedbackTopics({ bank: [] });
    expect(result).not.toContain('11987654321');
    // No element in the result should be a pure-digit string
    expect(result.some(t => /^\d+$/.test(t))).toBe(false);
  });

  it('respects windowMs — messages older than 5 minutes before Nick reply are not counted', () => {
    const oldMsg = { ts: '2024-01-01T09:50:00.000Z', from_me: false, body: 'antiguidade palavra velha palavra velha' };
    const recentMsg = { ts: '2024-01-01T10:04:00.000Z', from_me: false, body: 'recente nova palavra nova' };
    const nick = { ts: '2024-01-01T10:05:00.000Z', from_me: true, body: 'ok' };
    // oldMsg is > 5 minutes before nick, so should not contribute
    // recentMsg is < 5 minutes before nick, so should contribute
    writeGroupFile('group1', '2024-01-01', [oldMsg, recentMsg, nick]);
    const result = extractFeedbackTopics({ bank: [], minCount: 1 });
    expect(result).toContain('recente');
    expect(result).not.toContain('antiguidade');
  });

  it('respects 3-preceding-message cap', () => {
    // 5 messages before Nick's reply — only the 3 most recent should count
    const msgs = [
      { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'palavra1 excluida excluida' },
      { ts: '2024-01-01T10:00:30.000Z', from_me: false, body: 'palavra2 excluida excluida' },
      { ts: '2024-01-01T10:01:00.000Z', from_me: false, body: 'incluida incluida incluida' },
      { ts: '2024-01-01T10:01:30.000Z', from_me: false, body: 'incluida incluida incluida' },
      { ts: '2024-01-01T10:02:00.000Z', from_me: false, body: 'incluida incluida incluida' },
      { ts: '2024-01-01T10:03:00.000Z', from_me: true, body: 'ok' },
    ];
    writeGroupFile('group1', '2024-01-01', msgs);
    const result = extractFeedbackTopics({ bank: [], minCount: 1 });
    // "incluida" appears in the 3 most recent pre-Nick messages
    expect(result).toContain('incluida');
    // "excluida" only appears in messages 1 and 2 (outside the 3-msg cap)
    expect(result).not.toContain('excluida');
  });

  it('returns at most topN (30) results', () => {
    // Create 35 distinct words each appearing 3 times
    const lines: object[] = [];
    const words = Array.from({ length: 35 }, (_, i) => `uniqueword${i}`);
    // Write 3 groups of (3 context messages + 1 nick message)
    for (let round = 0; round < 3; round++) {
      const baseTs = new Date(`2024-01-0${round + 1}T10:00:00.000Z`).getTime();
      for (let i = 0; i < words.length; i++) {
        lines.push({
          ts: new Date(baseTs + i * 60000).toISOString(),
          from_me: false,
          body: words[i],
        });
      }
      lines.push({
        ts: new Date(baseTs + words.length * 60000).toISOString(),
        from_me: true,
        body: 'ok',
      });
    }
    writeGroupFile('group1', '2024-01-01', lines);
    const result = extractFeedbackTopics({ bank: [], minCount: 1 });
    expect(result.length).toBeLessThanOrEqual(30);
  });

  it('ties are broken alphabetically', () => {
    // "bravo" and "alfa" both appear 3 times — expect alfa before bravo
    const msg = { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'bravo alfa bravo alfa bravo alfa' };
    const nick = { ts: '2024-01-01T10:01:00.000Z', from_me: true, body: 'ok' };
    writeGroupFile('group1', '2024-01-01', [msg, nick]);
    const result = extractFeedbackTopics({ bank: [], minCount: 1 });
    const alfaIdx = result.indexOf('alfa');
    const bravoIdx = result.indexOf('bravo');
    expect(alfaIdx).toBeGreaterThanOrEqual(0);
    expect(bravoIdx).toBeGreaterThanOrEqual(0);
    expect(alfaIdx).toBeLessThan(bravoIdx);
  });
});

describe('saveFeedbackTopics + loadFeedbackTopics round-trip', () => {
  it('saves and loads topic list correctly', () => {
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    saveFeedbackTopics(['futebol', 'tennis', 'startups']);
    const loaded = loadFeedbackTopics();
    expect(loaded).toEqual(['futebol', 'tennis', 'startups']);
  });

  it('loadFeedbackTopics returns [] when file missing', () => {
    expect(loadFeedbackTopics()).toEqual([]);
  });
});

describe('maybeRefreshFeedbackTopics', () => {
  it('re-extracts when groups mtime is newer than feedback-topics mtime', () => {
    // Create groups dir with a JSONL file
    const msg = { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'futebol futebol futebol' };
    const nick = { ts: '2024-01-01T10:01:00.000Z', from_me: true, body: 'ok' };
    writeGroupFile('group1', '2024-01-01', [msg, nick]);

    // Write a stale feedback-topics.json with old mtime
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    const fbPath = path.join(tmpDir, 'data', 'feedback-topics.json');
    fs.writeFileSync(fbPath, JSON.stringify({ updated: '2020-01-01T00:00:00.000Z', topics: [] }), 'utf8');
    // Force old mtime
    const oldTime = new Date('2020-01-01').getTime() / 1000;
    fs.utimesSync(fbPath, oldTime, oldTime);

    const result = maybeRefreshFeedbackTopics([]);
    expect(result.refreshed).toBe(true);
    expect(result.count).toBeGreaterThan(0);
  });

  it('is a no-op when feedback-topics is fresher than all groups files', () => {
    // Create groups dir with a JSONL file (old mtime)
    const msg = { ts: '2024-01-01T10:00:00.000Z', from_me: false, body: 'futebol futebol futebol' };
    const nick = { ts: '2024-01-01T10:01:00.000Z', from_me: true, body: 'ok' };
    writeGroupFile('group1', '2024-01-01', [msg, nick]);

    // Force old mtime on groups file
    const groupFile = path.join(tmpDir, 'data', 'groups', 'group1', '2024-01-01.jsonl');
    const oldTime = new Date('2020-01-01').getTime() / 1000;
    fs.utimesSync(groupFile, oldTime, oldTime);

    // Write a fresh feedback-topics.json (recent mtime — default fs.writeFileSync = now)
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    const fbPath = path.join(tmpDir, 'data', 'feedback-topics.json');
    fs.writeFileSync(fbPath, JSON.stringify({ updated: new Date().toISOString(), topics: ['tennis'] }), 'utf8');

    const result = maybeRefreshFeedbackTopics([]);
    expect(result.refreshed).toBe(false);
    expect(result.count).toBe(1); // returns existing count from file
  });
});
