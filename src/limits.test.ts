import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  defaultLimitsConfig,
  loadLimitsConfig,
  saveLimitsConfig,
  ensureDailyReset,
  getEffectiveLimit,
  shouldAllowReply,
  shouldAllowReplyWithPending,
  recordReply,
  setDefaultLimit,
  setGroupLimit,
  normalizeChatKey,
  LIMITS_CONFIG_PATH,
  type LimitsConfig,
} from './limits';

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-test-'));
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('defaultLimitsConfig', () => {
  it('returns null defaultPerGroup (unlimited) and empty maps', () => {
    const cfg = defaultLimitsConfig();
    expect(cfg.defaultPerGroup).toBeNull();
    expect(cfg.perGroup).toEqual({});
    expect(cfg.counts).toEqual({});
    expect(cfg.lastReset).toBe(today());
  });
});

describe('loadLimitsConfig', () => {
  it('returns defaults when file is missing', () => {
    const cfg = loadLimitsConfig();
    expect(cfg.defaultPerGroup).toBeNull();
    expect(cfg.perGroup).toEqual({});
    expect(cfg.counts).toEqual({});
  });

  it('returns defaults when file is malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, LIMITS_CONFIG_PATH), 'not valid json', 'utf8');
    const cfg = loadLimitsConfig();
    expect(cfg.defaultPerGroup).toBeNull();
  });

  it('returns defaults when schema is invalid', () => {
    fs.writeFileSync(
      path.join(tmpDir, LIMITS_CONFIG_PATH),
      JSON.stringify({ defaultPerGroup: 'wrong-type', perGroup: {}, counts: {}, lastReset: '2026-04-19' }),
      'utf8',
    );
    const cfg = loadLimitsConfig();
    expect(cfg.defaultPerGroup).toBeNull();
  });

  it('rejects a negative defaultPerGroup and falls back to defaults', () => {
    // A negative limit would silently become a global kill switch
    // (current < -1 is never true). Must be rejected by the schema.
    fs.writeFileSync(
      path.join(tmpDir, LIMITS_CONFIG_PATH),
      JSON.stringify({ defaultPerGroup: -1, perGroup: {}, counts: {}, lastReset: '2026-04-19' }),
      'utf8',
    );
    const cfg = loadLimitsConfig();
    expect(cfg.defaultPerGroup).toBeNull();
  });

  it('rejects a non-integer defaultPerGroup', () => {
    fs.writeFileSync(
      path.join(tmpDir, LIMITS_CONFIG_PATH),
      JSON.stringify({ defaultPerGroup: 1.5, perGroup: {}, counts: {}, lastReset: '2026-04-19' }),
      'utf8',
    );
    expect(loadLimitsConfig().defaultPerGroup).toBeNull();
  });

  it('rejects NaN / Infinity in defaultPerGroup', () => {
    // NaN and Infinity serialize to JSON as `null`, so hand-crafted inputs
    // are what we have to guard against. Write raw JSON that decodes to a
    // number that fails Number.isInteger.
    fs.writeFileSync(
      path.join(tmpDir, LIMITS_CONFIG_PATH),
      '{"defaultPerGroup": 1e999, "perGroup": {}, "counts": {}, "lastReset": "2026-04-19"}',
      'utf8',
    );
    expect(loadLimitsConfig().defaultPerGroup).toBeNull();
  });

  it('rejects a negative value inside perGroup', () => {
    fs.writeFileSync(
      path.join(tmpDir, LIMITS_CONFIG_PATH),
      JSON.stringify({ defaultPerGroup: 3, perGroup: { mgz: -5 }, counts: {}, lastReset: '2026-04-19' }),
      'utf8',
    );
    const cfg = loadLimitsConfig();
    expect(cfg.perGroup).toEqual({});
    expect(cfg.defaultPerGroup).toBeNull();
  });

  it('rejects a non-integer value inside counts', () => {
    fs.writeFileSync(
      path.join(tmpDir, LIMITS_CONFIG_PATH),
      JSON.stringify({ defaultPerGroup: 3, perGroup: {}, counts: { mgz: 2.5 }, lastReset: '2026-04-19' }),
      'utf8',
    );
    expect(loadLimitsConfig().counts).toEqual({});
  });
});

describe('saveLimitsConfig + loadLimitsConfig roundtrip', () => {
  it('preserves all fields', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 3,
      perGroup: { mgz: 5, 'other group': 1 },
      counts: { mgz: 2 },
      lastReset: '2026-04-19',
    };
    saveLimitsConfig(cfg);
    const loaded = loadLimitsConfig();
    expect(loaded).toEqual(cfg);
  });
});

describe('ensureDailyReset', () => {
  it('no-ops when lastReset is today', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 3,
      perGroup: { mgz: 5 },
      counts: { mgz: 2 },
      lastReset: today(),
    };
    const result = ensureDailyReset(cfg);
    expect(result).toEqual(cfg);
  });

  it('clears counts and updates lastReset when day changed', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 3,
      perGroup: { mgz: 5 },
      counts: { mgz: 2, other: 1 },
      lastReset: '2024-01-01',
    };
    const result = ensureDailyReset(cfg);
    expect(result.counts).toEqual({});
    expect(result.lastReset).toBe(today());
    // Must not mutate perGroup or defaultPerGroup
    expect(result.perGroup).toEqual({ mgz: 5 });
    expect(result.defaultPerGroup).toBe(3);
  });

  it('is pure — does not mutate input', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: null,
      perGroup: {},
      counts: { mgz: 9 },
      lastReset: '2024-01-01',
    };
    const snapshot = JSON.stringify(cfg);
    ensureDailyReset(cfg);
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });
});

describe('getEffectiveLimit', () => {
  it('returns per-group override when set', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 10,
      perGroup: { mgz: 3 },
      counts: {},
      lastReset: today(),
    };
    expect(getEffectiveLimit(cfg, 'mgz')).toBe(3);
  });

  it('falls back to defaultPerGroup when no per-group override', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 10,
      perGroup: {},
      counts: {},
      lastReset: today(),
    };
    expect(getEffectiveLimit(cfg, 'mgz')).toBe(10);
  });

  it('returns null (unlimited) when neither is set', () => {
    const cfg = defaultLimitsConfig();
    expect(getEffectiveLimit(cfg, 'anything')).toBeNull();
  });

  it('normalizes the chat key (case-insensitive, trimmed)', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: null,
      perGroup: { mgz: 5 },
      counts: {},
      lastReset: today(),
    };
    expect(getEffectiveLimit(cfg, '  MGZ  ')).toBe(5);
  });

  it('per-group override of 0 wins over a positive default', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 10,
      perGroup: { muted: 0 },
      counts: {},
      lastReset: today(),
    };
    expect(getEffectiveLimit(cfg, 'muted')).toBe(0);
  });
});

describe('shouldAllowReply', () => {
  it('allows when under the effective limit', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 3,
      perGroup: {},
      counts: { mgz: 1 },
      lastReset: today(),
    };
    const result = shouldAllowReply(cfg, 'mgz');
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    expect(result.limit).toBe(3);
  });

  it('blocks when count equals the limit', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 3,
      perGroup: {},
      counts: { mgz: 3 },
      lastReset: today(),
    };
    expect(shouldAllowReply(cfg, 'mgz').allowed).toBe(false);
  });

  it('blocks when limit is 0 (kill switch)', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: null,
      perGroup: { muted: 0 },
      counts: {},
      lastReset: today(),
    };
    const result = shouldAllowReply(cfg, 'muted');
    expect(result.allowed).toBe(false);
    expect(result.limit).toBe(0);
  });

  it('always allows when no limit is configured (null)', () => {
    const cfg = defaultLimitsConfig();
    const result = shouldAllowReply(cfg, 'any');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
  });

  it('normalizes the chat key when reading counts', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 3,
      perGroup: {},
      counts: { mgz: 3 },
      lastReset: today(),
    };
    expect(shouldAllowReply(cfg, '  MGZ  ').allowed).toBe(false);
  });
});

describe('shouldAllowReplyWithPending', () => {
  // Covers the concurrency race: if N handlers in the same group all ran
  // shouldAllowReply before any of them persisted their increment, they'd
  // each see the same `current` and overshoot the cap by N-1. Callers pass
  // a live in-memory count of in-flight reservations so the decision becomes
  // current + pending < limit.
  const cfg: LimitsConfig = {
    defaultPerGroup: 3,
    perGroup: {},
    counts: { mgz: 1 },
    lastReset: new Date().toISOString().slice(0, 10),
  };

  it('allows when current + pending is still under the limit', () => {
    // current=1, pending=1 → effective=2, limit=3 → allowed
    expect(shouldAllowReplyWithPending(cfg, 'mgz', 1).allowed).toBe(true);
  });

  it('blocks when current + pending equals the limit', () => {
    // current=1, pending=2 → effective=3, limit=3 → blocked
    expect(shouldAllowReplyWithPending(cfg, 'mgz', 2).allowed).toBe(false);
  });

  it('blocks when current + pending exceeds the limit', () => {
    expect(shouldAllowReplyWithPending(cfg, 'mgz', 5).allowed).toBe(false);
  });

  it('treats negative pending as 0 (defensive)', () => {
    // A buggy reservation accounting shouldn't enable overshoot.
    expect(shouldAllowReplyWithPending(cfg, 'mgz', -10).allowed).toBe(true);
    const atCap: LimitsConfig = { ...cfg, counts: { mgz: 3 } };
    expect(shouldAllowReplyWithPending(atCap, 'mgz', -10).allowed).toBe(false);
  });

  it('always allows when limit is null (unlimited)', () => {
    const unlimited = defaultLimitsConfig();
    expect(shouldAllowReplyWithPending(unlimited, 'mgz', 999).allowed).toBe(true);
  });

  it('shouldAllowReply (pending=0 variant) agrees with shouldAllowReplyWithPending', () => {
    // Regression guard: shouldAllowReply must stay the "pending=0" special case
    // of shouldAllowReplyWithPending.
    expect(shouldAllowReply(cfg, 'mgz').allowed).toBe(
      shouldAllowReplyWithPending(cfg, 'mgz', 0).allowed,
    );
  });
});

describe('recordReply', () => {
  it('increments the count for a chat key', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: null,
      perGroup: {},
      counts: { mgz: 2 },
      lastReset: today(),
    };
    const next = recordReply(cfg, 'mgz');
    expect(next.counts.mgz).toBe(3);
  });

  it('creates an entry at 1 when missing', () => {
    const cfg = defaultLimitsConfig();
    const next = recordReply(cfg, 'new-chat');
    expect(next.counts['new-chat']).toBe(1);
  });

  it('normalizes the chat key when writing', () => {
    const cfg = defaultLimitsConfig();
    const next = recordReply(cfg, '  MGZ  ');
    expect(next.counts.mgz).toBe(1);
    expect(next.counts['  MGZ  ']).toBeUndefined();
  });

  it('is pure — does not mutate input', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: null,
      perGroup: {},
      counts: { mgz: 2 },
      lastReset: today(),
    };
    const snapshot = JSON.stringify(cfg);
    recordReply(cfg, 'mgz');
    expect(JSON.stringify(cfg)).toBe(snapshot);
  });
});

describe('setDefaultLimit', () => {
  it('sets the default when given a non-negative integer', () => {
    const cfg = defaultLimitsConfig();
    const next = setDefaultLimit(cfg, 3);
    expect(next.defaultPerGroup).toBe(3);
  });

  it('allows 0 as a valid default (kill switch)', () => {
    const cfg = defaultLimitsConfig();
    const next = setDefaultLimit(cfg, 0);
    expect(next.defaultPerGroup).toBe(0);
  });

  it('clears the default when given null', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: 5,
      perGroup: {},
      counts: {},
      lastReset: today(),
    };
    const next = setDefaultLimit(cfg, null);
    expect(next.defaultPerGroup).toBeNull();
  });
});

describe('setGroupLimit', () => {
  it('sets a per-group override', () => {
    const cfg = defaultLimitsConfig();
    const next = setGroupLimit(cfg, 'mgz', 3);
    expect(next.perGroup.mgz).toBe(3);
  });

  it('normalizes the chat key', () => {
    const cfg = defaultLimitsConfig();
    const next = setGroupLimit(cfg, '  MGZ  ', 3);
    expect(next.perGroup.mgz).toBe(3);
    expect(next.perGroup['  MGZ  ']).toBeUndefined();
  });

  it('removes the per-group entry when value is null', () => {
    const cfg: LimitsConfig = {
      defaultPerGroup: null,
      perGroup: { mgz: 5, other: 1 },
      counts: {},
      lastReset: today(),
    };
    const next = setGroupLimit(cfg, 'mgz', null);
    expect(next.perGroup).toEqual({ other: 1 });
  });

  it('allows 0 as a per-group kill switch', () => {
    const cfg = defaultLimitsConfig();
    const next = setGroupLimit(cfg, 'muted', 0);
    expect(next.perGroup.muted).toBe(0);
  });

  it('throws when the normalized chat key is empty', () => {
    const cfg = defaultLimitsConfig();
    expect(() => setGroupLimit(cfg, '', 3)).toThrow(/non-empty/);
    expect(() => setGroupLimit(cfg, '   ', 3)).toThrow(/non-empty/);
  });
});

describe('normalizeChatKey', () => {
  it('lowercases and trims', () => {
    expect(normalizeChatKey('  MGZ  ')).toBe('mgz');
  });

  it('returns "" for whitespace-only input', () => {
    expect(normalizeChatKey('   ')).toBe('');
  });
});
