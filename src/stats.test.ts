import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { computeStats, formatStats, parseWindow, type StatsWindow } from './stats';
import type { EventBase } from './events';

// Helper: create a temp file with a list of events as JSONL
function writeEventsFile(filePath: string, events: Partial<EventBase>[]): void {
  const lines = events.map(e => JSON.stringify(e)).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines + (lines ? '\n' : ''), 'utf8');
}

// Helper: create an ISO timestamp N hours ago from now
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

// Helper: create an ISO timestamp N days ago from now
function daysAgo(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

let tmpDir: string;
let eventsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-test-'));
  eventsFile = path.join(tmpDir, 'events.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseWindow', () => {
  it('parses 24h correctly', () => {
    const w = parseWindow('24h');
    expect(w).toBe('24h');
  });

  it('parses 7d correctly', () => {
    const w = parseWindow('7d');
    expect(w).toBe('7d');
  });

  it('parses all correctly', () => {
    const w = parseWindow('all');
    expect(w).toBe('all');
  });

  it('defaults unknown values to 24h', () => {
    const w = parseWindow('bogus');
    expect(w).toBe('24h');
  });
});

describe('computeStats', () => {
  it('empty file → empty-but-valid output with zero counts', () => {
    writeEventsFile(eventsFile, []);
    const stats = computeStats(eventsFile, '24h');
    expect(stats.replyCount).toBe(0);
    expect(stats.silentCount).toBe(0);
    expect(stats.skipTotal).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.claudeCallCount).toBe(0);
  });

  it('counts replies correctly: 3 reply.sent events → reports 3', () => {
    writeEventsFile(eventsFile, [
      { kind: 'reply.sent', ts: hoursAgo(1), chat: 'grp1', trigger: 'mention' },
      { kind: 'reply.sent', ts: hoursAgo(2), chat: 'grp2', trigger: 'reply' },
      { kind: 'reply.sent', ts: hoursAgo(3), chat: 'grp1', trigger: 'mention' },
    ]);
    const stats = computeStats(eventsFile, '24h');
    expect(stats.replyCount).toBe(3);
  });

  it('groups by trigger: 2 mention + 1 reply → reports mention=2 reply=1', () => {
    writeEventsFile(eventsFile, [
      { kind: 'reply.sent', ts: hoursAgo(1), trigger: 'mention', chat: 'grp1' },
      { kind: 'reply.sent', ts: hoursAgo(2), trigger: 'mention', chat: 'grp1' },
      { kind: 'reply.sent', ts: hoursAgo(3), trigger: 'reply', chat: 'grp1' },
    ]);
    const stats = computeStats(eventsFile, '24h');
    expect(stats.byTrigger['mention']).toBe(2);
    expect(stats.byTrigger['reply']).toBe(1);
  });

  it('skip breakdown by reason: 5 rate_limited + 10 not_mentioned → reports both counts', () => {
    const events: Partial<EventBase>[] = [
      ...Array(5).fill(null).map(() => ({ kind: 'skip.rate_limited' as const, ts: hoursAgo(1) })),
      ...Array(10).fill(null).map(() => ({ kind: 'skip.not_mentioned' as const, ts: hoursAgo(1) })),
    ];
    writeEventsFile(eventsFile, events);
    const stats = computeStats(eventsFile, '24h');
    expect(stats.skipTotal).toBe(15);
    expect(stats.skipByReason['rate_limited']).toBe(5);
    expect(stats.skipByReason['not_mentioned']).toBe(10);
  });

  it('window filter — 24h: events 25h ago are excluded', () => {
    writeEventsFile(eventsFile, [
      { kind: 'reply.sent', ts: hoursAgo(25), chat: 'grp1', trigger: 'mention' },
      { kind: 'reply.sent', ts: hoursAgo(1), chat: 'grp1', trigger: 'mention' },
    ]);
    const stats = computeStats(eventsFile, '24h');
    expect(stats.replyCount).toBe(1);
  });

  it('window filter — 7d: events 8d ago are excluded, events 6d ago are included', () => {
    writeEventsFile(eventsFile, [
      { kind: 'reply.sent', ts: daysAgo(8), chat: 'grp1', trigger: 'mention' },
      { kind: 'reply.sent', ts: daysAgo(6), chat: 'grp1', trigger: 'mention' },
    ]);
    const stats = computeStats(eventsFile, '7d');
    expect(stats.replyCount).toBe(1);
  });

  it('window filter — all: nothing is excluded', () => {
    writeEventsFile(eventsFile, [
      { kind: 'reply.sent', ts: daysAgo(365), chat: 'grp1', trigger: 'mention' },
      { kind: 'reply.sent', ts: daysAgo(1), chat: 'grp1', trigger: 'mention' },
    ]);
    const stats = computeStats(eventsFile, 'all');
    expect(stats.replyCount).toBe(2);
  });

  it('duration percentiles: [10, 20, 30, 40, 50] → p50=30, p95≈48, p99≈49', () => {
    const durations = [10, 20, 30, 40, 50];
    const events = durations.map(d => ({
      kind: 'claude.call' as const,
      ts: hoursAgo(1),
      duration_ms: d * 1000,
    }));
    writeEventsFile(eventsFile, events);
    const stats = computeStats(eventsFile, '24h');
    expect(stats.claudeCallCount).toBe(5);
    // p50 should be 30s (30000ms)
    expect(stats.claudeDurationP50).toBe(30000);
    // p95 should be approximately 48s (within ±3s tolerance)
    expect(stats.claudeDurationP95).toBeGreaterThanOrEqual(45000);
    expect(stats.claudeDurationP95).toBeLessThanOrEqual(51000);
    // p99 should be approximately 49s (within ±3s tolerance)
    expect(stats.claudeDurationP99).toBeGreaterThanOrEqual(46000);
    expect(stats.claudeDurationP99).toBeLessThanOrEqual(52000);
  });

  it('malformed line is skipped: file with one good line + one bad line → counts good one', () => {
    const goodLine = JSON.stringify({ kind: 'reply.sent', ts: hoursAgo(1), chat: 'grp1', trigger: 'mention' });
    const badLine = 'this is not valid json {{{{';
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.writeFileSync(eventsFile, goodLine + '\n' + badLine + '\n', 'utf8');
    // Should not throw, and should count the good event
    expect(() => computeStats(eventsFile, '24h')).not.toThrow();
    const stats = computeStats(eventsFile, '24h');
    expect(stats.replyCount).toBe(1);
  });
});

describe('formatStats', () => {
  it('produces output with required headers for empty stats', () => {
    writeEventsFile(eventsFile, []);
    const stats = computeStats(eventsFile, '24h');
    const output = formatStats(stats, '24h');
    expect(output).toContain('=== WhatsApp bot stats');
    expect(output).toContain('Replies:');
    expect(output).toContain('Skips');
    expect(output).toContain('Claude calls:');
  });

  it('shows reply count in formatted output', () => {
    writeEventsFile(eventsFile, [
      { kind: 'reply.sent', ts: hoursAgo(1), trigger: 'mention', chat: 'grp1' },
      { kind: 'reply.sent', ts: hoursAgo(2), trigger: 'reply', chat: 'grp1' },
    ]);
    const stats = computeStats(eventsFile, '24h');
    const output = formatStats(stats, '24h');
    expect(output).toContain('2');
  });
});
