import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from './atomic';
import { bestFuzzyMatch, scoreFuzzy } from './fuzzy';
import { callClaude } from './claude';
import { VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT, AMBIENT_CLASSIFIER_PROMPT, fillTemplate } from './prompts';
import { loadFeedbackTopics } from './feedback-topics';

export const AMBIENT_CONFIG_PATH = 'data/ambient-config.json';

export interface AmbientConfig {
  masterEnabled: boolean;
  disabledGroups: string[];
  explicitTopics: string[];
  dailyCap: number;
  confidenceThreshold: number;
  voiceProfileTopics: string[];
  voiceProfileMtime: number;
  repliesToday: string[];
  lastReset: string;
}

export function defaultAmbientConfig(): AmbientConfig {
  return {
    masterEnabled: false,
    disabledGroups: [],
    explicitTopics: [],
    dailyCap: 30,
    confidenceThreshold: 0.5,
    voiceProfileTopics: [],
    voiceProfileMtime: 0,
    repliesToday: [],
    lastReset: new Date().toISOString().slice(0, 10),
  };
}

// Resolve the config path at call time so process.chdir() in tests works.
function resolvedConfigPath(): string {
  return path.join(process.cwd(), AMBIENT_CONFIG_PATH);
}

// Caps mirror the add-time limits in cmdTopic (src/commands.ts) so a hand-edited
// config cannot bypass them. Values over the caps are truncated at load time with
// a warning; the config itself remains valid.
const MAX_TOPIC_LENGTH = 64;
const MAX_TOPIC_BANK = 200;

function isValidAmbientConfig(obj: unknown): obj is AmbientConfig {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.masterEnabled === 'boolean' &&
    Array.isArray(c.disabledGroups) &&
    Array.isArray(c.explicitTopics) &&
    typeof c.dailyCap === 'number' &&
    typeof c.confidenceThreshold === 'number' &&
    Array.isArray(c.voiceProfileTopics) &&
    typeof c.voiceProfileMtime === 'number' &&
    Array.isArray(c.repliesToday) &&
    typeof c.lastReset === 'string'
  );
}

function clampExplicitTopics(cfg: AmbientConfig): AmbientConfig {
  const kept = cfg.explicitTopics
    .filter((t): t is string => typeof t === 'string' && t.length <= MAX_TOPIC_LENGTH)
    .slice(0, MAX_TOPIC_BANK);
  if (kept.length !== cfg.explicitTopics.length) {
    console.warn(
      `[ambient] explicitTopics truncated to ${kept.length}/${cfg.explicitTopics.length} ` +
      `(cap: ${MAX_TOPIC_BANK} entries, ${MAX_TOPIC_LENGTH} chars each)`
    );
    return { ...cfg, explicitTopics: kept };
  }
  return cfg;
}

export function loadAmbientConfig(): AmbientConfig {
  const cfgPath = resolvedConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidAmbientConfig(parsed)) {
      console.warn('[ambient] ambient-config.json failed schema validation, using defaults');
      return defaultAmbientConfig();
    }
    return clampExplicitTopics(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[ambient] failed to parse ambient config, using defaults:', (err as Error).message);
    }
    return defaultAmbientConfig();
  }
}

export function saveAmbientConfig(cfg: AmbientConfig): void {
  const cfgPath = resolvedConfigPath();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  atomicWriteFile(cfgPath, JSON.stringify(cfg, null, 2));
}

// Returns today's date as "YYYY-MM-DD".
function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// If today's date differs from cfg.lastReset, clear repliesToday and update lastReset.
// Pure — does NOT save. Returns the possibly-updated config.
export function ensureDailyReset(cfg: AmbientConfig): AmbientConfig {
  const today = todayString();
  if (cfg.lastReset === today) return cfg;
  return { ...cfg, repliesToday: [], lastReset: today };
}

// Parse a named section from a single markdown file's content.
// Returns raw (trimmed) bullet text from that section.
// isFacts: if true, bullet text is truncated to the first 6 words.
function parseSectionBullets(content: string, sectionPattern: RegExp, isFacts = false): string[] {
  const topics: string[] = [];
  const lines = content.split('\n');
  let inSection = false;

  for (const line of lines) {
    if (sectionPattern.test(line.trim())) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Any new ## heading ends the section.
      if (/^##/.test(line)) {
        inSection = false;
        continue;
      }
      // Bullet lines: "- topic text"
      const match = line.match(/^[-*]\s+(.+)$/);
      if (match) {
        let text = match[1].trim().toLowerCase();
        if (!text) continue;
        if (isFacts) {
          // Truncate to first 6 words.
          const words = text.split(/\s+/);
          text = words.slice(0, 6).join(' ');
        }
        if (text) topics.push(text);
      }
    }
  }

  return topics;
}

// Read all data/contacts/*.md, parse ## Recurring topics, ## Open threads, and ## Facts.
// Facts bullets are truncated to their first 6 words.
// Returns deduped, lowercased topics.
export function loadMemoryTopics(): string[] {
  const contactsDir = path.join(process.cwd(), 'data', 'contacts');
  let files: string[];
  try {
    files = fs.readdirSync(contactsDir).filter(name => name.endsWith('.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const seen = new Set<string>();
  const topics: string[] = [];

  function addTopic(t: string): void {
    if (t && !seen.has(t)) {
      seen.add(t);
      topics.push(t);
    }
  }

  for (const file of files) {
    const filePath = path.join(contactsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const t of parseSectionBullets(content, /^##\s+recurring topics\s*$/i)) {
        addTopic(t);
      }
      for (const t of parseSectionBullets(content, /^##\s+open threads\s*$/i)) {
        addTopic(t);
      }
      for (const t of parseSectionBullets(content, /^##\s+facts\s*$/i, true)) {
        addTopic(t);
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return topics;
}

// Builds the merged topic bank from: explicit + voice-profile-topics + memory-topics + feedback-topics.
// Caller can pass already-loaded topic lists (for tests / callers that already have them loaded
// to avoid double I/O). When not passed, each list is loaded lazily.
export function buildTopicBank(
  cfg: AmbientConfig,
  memoryTopics?: string[],
  feedbackTopics?: string[],
): string[] {
  const resolved = memoryTopics ?? loadMemoryTopics();
  const feedback = feedbackTopics ?? loadFeedbackTopics();
  const seen = new Set<string>();
  const bank: string[] = [];

  for (const topic of [...cfg.explicitTopics, ...cfg.voiceProfileTopics, ...resolved, ...feedback]) {
    const t = topic.toLowerCase().trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      bank.push(t);
    }
  }

  return bank;
}

export interface AmbientDecision {
  pass: boolean;
  reason: string;
  matchedTopic?: string;
  score?: number;
}

// Normalize chat name for comparison against disabledGroups.
function normalizeChatKey(name: string): string {
  return name.toLowerCase().trim();
}

// Gate decision: does this message qualify for ambient consideration?
// Checks all 6 gate steps in order.
export function shouldAmbientReply(params: {
  cfg: AmbientConfig;
  chatName: string;
  messageBody: string;
  topicBank: string[];
}): AmbientDecision {
  const { cfg, chatName, messageBody, topicBank } = params;

  // 1. Master switch
  if (!cfg.masterEnabled) {
    return { pass: false, reason: 'master disabled' };
  }

  // 2. Per-group disable list
  const normalizedChat = normalizeChatKey(chatName);
  if (cfg.disabledGroups.some(g => normalizeChatKey(g) === normalizedChat)) {
    return { pass: false, reason: 'group disabled' };
  }

  // 3. Daily cap
  if (cfg.repliesToday.length >= cfg.dailyCap) {
    return { pass: false, reason: 'daily cap reached' };
  }

  // 4. Message too short
  if (messageBody.trim().length < 3) {
    return { pass: false, reason: 'message too short' };
  }

  // 5. Empty topic bank
  if (topicBank.length === 0) {
    return { pass: false, reason: 'no topics configured' };
  }

  // 6. Fuzzy match
  const match = bestFuzzyMatch(messageBody, topicBank, cfg.confidenceThreshold);
  if (!match) {
    return { pass: false, reason: 'no fuzzy match' };
  }

  return {
    pass: true,
    reason: 'topic match',
    matchedTopic: match.topic,
    score: match.score,
  };
}

// After a successful ambient reply: append timestamp + ensureDailyReset.
// Pure — does NOT save. Returns the updated config.
export function recordAmbientReply(cfg: AmbientConfig): AmbientConfig {
  const reset = ensureDailyReset(cfg);
  const timestamp = new Date().toISOString();
  return { ...reset, repliesToday: [...reset.repliesToday, timestamp] };
}

// Call claude (no tools) with VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT to extract
// topic keywords. Parse newline-separated output, trim, lowercase, filter empty
// lines, deduplicate. Returns up to 20 topics.
// If the voice profile file is missing, returns [].
// On claude failure, returns [] and logs a warning (never throws).
export async function extractVoiceProfileTopics(
  voiceProfilePath?: string,
): Promise<string[]> {
  const vpPath = voiceProfilePath ?? path.join(process.cwd(), 'data', 'voice_profile.md');

  // If voice profile doesn't exist, return empty
  let voiceProfile: string;
  try {
    voiceProfile = fs.readFileSync(vpPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }

  const prompt = fillTemplate(VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT, {
    VOICE_PROFILE: voiceProfile,
  });

  let output: string;
  try {
    output = await callClaude(prompt);
  } catch (err) {
    console.warn('[ambient] extractVoiceProfileTopics: claude failed:', (err as Error).message);
    return [];
  }

  const seen = new Set<string>();
  const topics: string[] = [];

  for (const line of output.split('\n')) {
    const t = line.trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      topics.push(t);
      if (topics.length >= 20) break;
    }
  }

  return topics;
}

// Refreshes voiceProfileTopics in the config if the voice profile's mtime
// has changed since last extraction. No-op otherwise. Saves the config.
export async function maybeRefreshVoiceProfileTopics(): Promise<{
  refreshed: boolean;
  count: number;
}> {
  const vpPath = path.join(process.cwd(), 'data', 'voice_profile.md');

  let mtime = 0;
  try {
    const stat = fs.statSync(vpPath);
    mtime = stat.mtimeMs;
  } catch {
    return { refreshed: false, count: 0 };
  }

  const cfg = ensureDailyReset(loadAmbientConfig());
  if (cfg.voiceProfileMtime === mtime) {
    return { refreshed: false, count: cfg.voiceProfileTopics.length };
  }

  const topics = await extractVoiceProfileTopics(vpPath);
  const updated: AmbientConfig = {
    ...cfg,
    voiceProfileTopics: topics,
    voiceProfileMtime: mtime,
  };
  saveAmbientConfig(updated);
  return { refreshed: true, count: topics.length };
}

// ---------------------------------------------------------------------------
// Haiku fallback classifier (Task 02)
// ---------------------------------------------------------------------------

// LRU cache: sha256(normalizedBody) → AmbientDecision
// Max 500 entries; evict oldest on overflow.
const HAIKU_CACHE_MAX = 500;
const haikuCache = new Map<string, AmbientDecision>();

// Dependency-injection seam — tests can replace `.fn` to avoid spawning a
// real subprocess. Intentionally a plain object so the reference is stable
// across module reloads.
export const _haikuImpl: { fn: (prompt: string) => Promise<string> } = {
  fn: (prompt: string) => callClaude(prompt, { model: 'claude-haiku-4-5-20251001' }),
};

const HAIKU_SCORE_FLOOR = 0.35;

export interface RefineParams {
  originalDecision: AmbientDecision;
  topScore: number;
  messageBody: string;
  topicBank: string[];
  cfg: AmbientConfig;
}

// Called after shouldAmbientReply returned { pass: false, reason: 'no fuzzy match' }
// when the top bigram score is still within the ambiguous band (>= 0.35).
// Asks Haiku to classify semantically. Caches by sha256 of normalized body.
export async function refineAmbientDecision(params: RefineParams): Promise<AmbientDecision> {
  const { originalDecision, topScore, messageBody, topicBank } = params;

  // Only refine fuzzy-miss decisions.
  if (originalDecision.reason !== 'no fuzzy match') return originalDecision;

  // Below floor: signal is too weak, don't bother Haiku.
  if (topScore < HAIKU_SCORE_FLOOR) return originalDecision;

  // Cap body to 2000 chars.
  const cappedBody = messageBody.slice(0, 2000);

  // Cache lookup.
  const cacheKey = crypto.createHash('sha256').update(cappedBody).digest('hex');
  const cached = haikuCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Build the prompt.
  const prompt = fillTemplate(AMBIENT_CLASSIFIER_PROMPT, {
    TOPIC_BANK: topicBank.join('\n'),
    MESSAGE: cappedBody,
  });

  let rawOutput: string;
  try {
    rawOutput = await _haikuImpl.fn(prompt);
  } catch (err) {
    console.warn('[ambient] refineAmbientDecision: haiku failed:', (err as Error).message);
    return originalDecision;
  }

  // Parse: "topic:<name>" or "none"
  const trimmed = rawOutput.trim().toLowerCase();
  let decision: AmbientDecision;

  if (trimmed === 'none' || trimmed === '') {
    decision = { pass: false, reason: 'haiku:none' };
  } else if (trimmed.startsWith('topic:')) {
    const name = trimmed.slice('topic:'.length).trim();
    if (!topicBank.includes(name)) {
      console.warn(`[ambient] refineAmbientDecision: haiku returned unknown topic "${name}"`);
      decision = { pass: false, reason: 'haiku:none' };
    } else {
      decision = { pass: true, reason: 'haiku classifier', matchedTopic: name, score: 0.5 };
    }
  } else {
    // Unparseable — treat as none.
    decision = { pass: false, reason: 'haiku:none' };
  }

  // Store in LRU cache with overflow eviction.
  if (haikuCache.size >= HAIKU_CACHE_MAX) {
    const oldest = haikuCache.keys().next().value;
    if (oldest !== undefined) haikuCache.delete(oldest);
  }
  haikuCache.set(cacheKey, decision);

  return decision;
}
