import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from './atomic';

export const LIMITS_CONFIG_PATH = 'data/limits-config.json';

// Per-group daily reply limits. Applies to ALL outbound triggers
// (mention, reply-to-bot, ambient) — not just ambient like ambient-config's
// dailyCap. A missing perGroup entry falls back to defaultPerGroup; a null
// defaultPerGroup means "no limit".
//
// Chat keys are normalized chat names (lowercase + trimmed), matching the
// convention used by silences and ambient.disabledGroups.
export interface LimitsConfig {
  defaultPerGroup: number | null;
  perGroup: Record<string, number>;
  counts: Record<string, number>;
  lastReset: string; // YYYY-MM-DD
}

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeChatKey(s: string): string {
  return s.trim().toLowerCase();
}

export function defaultLimitsConfig(): LimitsConfig {
  return {
    defaultPerGroup: null,
    perGroup: {},
    counts: {},
    lastReset: todayString(),
  };
}

function resolvedConfigPath(): string {
  return path.join(process.cwd(), LIMITS_CONFIG_PATH);
}

// Limits must be non-negative integers. `typeof === 'number'` alone would
// admit -1, 1.5, NaN, Infinity from a hand-edited config — the first would
// silently turn into a global kill switch (current < -1 is never true).
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isRecordOfNonNegInts(obj: unknown): obj is Record<string, number> {
  if (typeof obj !== 'object' || obj === null) return false;
  return Object.values(obj as Record<string, unknown>).every(isNonNegInt);
}

function isValidLimitsConfig(obj: unknown): obj is LimitsConfig {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;
  const defaultOk = c.defaultPerGroup === null || isNonNegInt(c.defaultPerGroup);
  return (
    defaultOk &&
    isRecordOfNonNegInts(c.perGroup) &&
    isRecordOfNonNegInts(c.counts) &&
    typeof c.lastReset === 'string'
  );
}

export function loadLimitsConfig(): LimitsConfig {
  const cfgPath = resolvedConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidLimitsConfig(parsed)) {
      console.warn('[limits] limits-config.json failed schema validation, using defaults');
      return defaultLimitsConfig();
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[limits] failed to parse limits config, using defaults:', (err as Error).message);
    }
    return defaultLimitsConfig();
  }
}

export function saveLimitsConfig(cfg: LimitsConfig): void {
  const cfgPath = resolvedConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  atomicWriteFile(cfgPath, JSON.stringify(cfg, null, 2));
}

// Pure — does NOT save. Returns the possibly-updated config.
export function ensureDailyReset(cfg: LimitsConfig): LimitsConfig {
  const today = todayString();
  if (cfg.lastReset === today) return cfg;
  return { ...cfg, counts: {}, lastReset: today };
}

export function getEffectiveLimit(cfg: LimitsConfig, chatKey: string): number | null {
  const key = normalizeChatKey(chatKey);
  if (Object.prototype.hasOwnProperty.call(cfg.perGroup, key)) {
    return cfg.perGroup[key];
  }
  return cfg.defaultPerGroup;
}

export interface AllowDecision {
  allowed: boolean;
  current: number;
  limit: number | null;
}

export function shouldAllowReply(cfg: LimitsConfig, chatKey: string): AllowDecision {
  return shouldAllowReplyWithPending(cfg, chatKey, 0);
}

// Same as shouldAllowReply but also takes an in-memory count of reservations
// for in-flight handlers in this chat. The runtime loads the config at check
// time and only writes after send, so without this accounting N concurrent
// handlers can each pass the check against a stale `current` and overshoot
// the cap by N-1. Callers pass the live reservation count; the decision
// becomes `current + pending < limit`.
export function shouldAllowReplyWithPending(
  cfg: LimitsConfig,
  chatKey: string,
  pending: number,
): AllowDecision {
  const key = normalizeChatKey(chatKey);
  const limit = getEffectiveLimit(cfg, key);
  const current = cfg.counts[key] ?? 0;
  if (limit === null) return { allowed: true, current, limit: null };
  return { allowed: current + Math.max(0, pending) < limit, current, limit };
}

export function recordReply(cfg: LimitsConfig, chatKey: string): LimitsConfig {
  const key = normalizeChatKey(chatKey);
  const current = cfg.counts[key] ?? 0;
  return {
    ...cfg,
    counts: { ...cfg.counts, [key]: current + 1 },
  };
}

export function setDefaultLimit(cfg: LimitsConfig, value: number | null): LimitsConfig {
  return { ...cfg, defaultPerGroup: value };
}

export function setGroupLimit(
  cfg: LimitsConfig,
  chatKey: string,
  value: number | null,
): LimitsConfig {
  const key = normalizeChatKey(chatKey);
  if (!key) {
    // Empty key would collide with the "no group arg" path in cmdLimit and
    // also silently bucket every nameless chat together. Refuse early.
    throw new Error('setGroupLimit: chatKey must be non-empty after normalization');
  }
  const nextPerGroup = { ...cfg.perGroup };
  if (value === null) {
    delete nextPerGroup[key];
  } else {
    nextPerGroup[key] = value;
  }
  return { ...cfg, perGroup: nextPerGroup };
}
