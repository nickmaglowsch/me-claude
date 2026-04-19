import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from './atomic';
import { bestFuzzyMatch } from './fuzzy';
import { callClaude } from './claude';
import { VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT, fillTemplate } from './prompts';

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

export function loadAmbientConfig(): AmbientConfig {
  const cfgPath = resolvedConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidAmbientConfig(parsed)) {
      console.warn('[ambient] ambient-config.json failed schema validation, using defaults');
      return defaultAmbientConfig();
    }
    return parsed;
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

// Parse the "## Recurring topics" section from a single markdown file's content.
// Returns lowercased topic strings from bullet lines in that section.
function parseRecurringTopics(content: string): string[] {
  const topics: string[] = [];
  const lines = content.split('\n');
  let inSection = false;

  for (const line of lines) {
    // Detect the section header (## Recurring topics, case-insensitive).
    if (/^##\s+recurring topics\s*$/i.test(line.trim())) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Any new ## heading ends the section.
      if (/^##/.test(line)) {
        break;
      }
      // Bullet lines: "- topic text"
      const match = line.match(/^[-*]\s+(.+)$/);
      if (match) {
        const topic = match[1].trim().toLowerCase();
        if (topic) topics.push(topic);
      }
    }
  }

  return topics;
}

// Read all data/contacts/*.md, parse "## Recurring topics" sections.
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

  for (const file of files) {
    const filePath = path.join(contactsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const topic of parseRecurringTopics(content)) {
        if (!seen.has(topic)) {
          seen.add(topic);
          topics.push(topic);
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }

  return topics;
}

// Builds the merged topic bank from: explicit + voice-profile-topics + memory-topics.
// Caller can pass an already-loaded memory-topics list (for tests / callers that
// already have memory topics loaded to avoid double I/O).
export function buildTopicBank(cfg: AmbientConfig, memoryTopics?: string[]): string[] {
  const resolved = memoryTopics ?? loadMemoryTopics();
  const seen = new Set<string>();
  const bank: string[] = [];

  for (const topic of [...cfg.explicitTopics, ...cfg.voiceProfileTopics, ...resolved]) {
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
