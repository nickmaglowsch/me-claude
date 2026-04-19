// feedback-topics.ts
// Extract topics from the message archive based on what Nick actually engages with.
// Each time Nick's bot replies in a group, the preceding messages are positive samples.

import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from './atomic';
import { normalize } from './fuzzy';

const FEEDBACK_TOPICS_PATH = 'data/feedback-topics.json';

// Short English + Portuguese stopwords (~60 words). Keep inline, keep small.
const STOPWORDS = new Set([
  // English
  'the', 'and', 'for', 'that', 'this', 'with', 'are', 'was', 'not', 'but',
  'from', 'they', 'have', 'had', 'has', 'you', 'your', 'its', 'can', 'all',
  'will', 'when', 'one', 'our', 'out', 'what', 'how', 'more', 'been', 'also',
  'just', 'like', 'get', 'got', 'him', 'her', 'his', 'she', 'who', 'did',
  // Portuguese
  'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'por',
  'para', 'com', 'uma', 'mas', 'que', 'nao', 'sao', 'tem', 'era', 'isso',
  'esse', 'essa', 'ele', 'ela', 'eles', 'elas', 'seu', 'sua', 'uns', 'umas',
  'foi', 'ser', 'ter', 'nos', 'mes', 'ano', 'dia', 'aqui', 'assim', 'muito',
]);

interface FeedbackRecord {
  updated: string;
  topics: string[];
}

export interface ExtractOpts {
  bank: string[];
  windowMs?: number;
  minCount?: number;
  topN?: number;
  groupsDir?: string;
  feedbackPath?: string;
}

// Scan groups JSONL files for messages preceding a Nick reply (from_me=true).
// Tokenize context messages, count, filter, return top N.
export function extractFeedbackTopics(opts: ExtractOpts): string[] {
  const {
    bank,
    windowMs = 300_000,   // 5 minutes default
    minCount = 3,
    topN = 30,
    groupsDir: groupsDirOpt,
    feedbackPath: _feedbackPath,
  } = opts;

  const groupsDir = groupsDirOpt ?? path.join(process.cwd(), 'data', 'groups');

  // Graceful degradation: no groups directory → return []
  let groupNames: string[];
  try {
    groupNames = fs.readdirSync(groupsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }

  const bankSet = new Set(bank.map(t => t.toLowerCase().trim()));
  const counts = new Map<string, number>();

  for (const groupName of groupNames) {
    const groupPath = path.join(groupsDir, groupName);
    let stat: fs.Stats;
    try { stat = fs.statSync(groupPath); } catch { continue; }
    if (!stat.isDirectory()) continue;

    let dayFiles: string[];
    try {
      dayFiles = fs.readdirSync(groupPath).filter(f => f.endsWith('.jsonl'));
    } catch { continue; }

    for (const dayFile of dayFiles) {
      const filePath = path.join(groupPath, dayFile);
      let raw: string;
      try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

      // Parse lines
      const lines: Array<{ ts: string; from_me: boolean; body: string }> = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj && typeof obj.ts === 'string' && typeof obj.from_me === 'boolean' && typeof obj.body === 'string') {
            lines.push({ ts: obj.ts, from_me: obj.from_me, body: obj.body });
          }
        } catch { /* skip malformed lines */ }
      }

      // For each Nick message, collect up to 3 preceding messages within windowMs
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].from_me) continue;

        const nickTs = new Date(lines[i].ts).getTime();
        const contextMsgs: string[] = [];

        // Walk backwards from i-1, collecting up to 3 non-Nick messages in window
        for (let j = i - 1; j >= 0 && contextMsgs.length < 3; j--) {
          if (lines[j].from_me) continue; // skip Nick's own messages
          const msgTs = new Date(lines[j].ts).getTime();
          if (nickTs - msgTs > windowMs) break; // outside window
          contextMsgs.push(lines[j].body);
        }

        // Tokenize each context message
        for (const body of contextMsgs) {
          const normalized = normalize(body);
          const tokens = normalized.split(/\s+/).filter(w => w.length >= 3);
          for (const token of tokens) {
            if (STOPWORDS.has(token)) continue;
            if (/^\d+$/.test(token)) continue; // pure digits
            if (bankSet.has(token)) continue;
            counts.set(token, (counts.get(token) ?? 0) + 1);
          }
        }
      }
    }
  }

  // Filter by minCount, sort by count desc then alphabetically for determinism
  const candidates = Array.from(counts.entries())
    .filter(([, count]) => count >= minCount)
    .sort(([a, ca], [b, cb]) => {
      if (cb !== ca) return cb - ca;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .slice(0, topN)
    .map(([word]) => word);

  return candidates;
}

// Load feedback topics from data/feedback-topics.json (relative to cwd).
// Returns [] if the file doesn't exist or is malformed.
export function loadFeedbackTopics(feedbackPath?: string): string[] {
  const fbPath = feedbackPath ?? path.join(process.cwd(), FEEDBACK_TOPICS_PATH);
  try {
    const raw = fs.readFileSync(fbPath, 'utf8');
    const parsed = JSON.parse(raw) as FeedbackRecord;
    if (Array.isArray(parsed.topics)) return parsed.topics;
    return [];
  } catch {
    return [];
  }
}

// Atomically write feedback topics to data/feedback-topics.json.
export function saveFeedbackTopics(topics: string[], feedbackPath?: string): void {
  const fbPath = feedbackPath ?? path.join(process.cwd(), FEEDBACK_TOPICS_PATH);
  fs.mkdirSync(path.dirname(fbPath), { recursive: true });
  const record: FeedbackRecord = {
    updated: new Date().toISOString(),
    topics,
  };
  atomicWriteFile(fbPath, JSON.stringify(record, null, 2));
}

// Process-level flag to avoid extracting more than once per process run.
let _refreshed = false;

// Compare mtime of the newest groups JSONL against feedback-topics.json.
// Re-extracts and saves if stale (or missing). Never runs more than once per process.
export function maybeRefreshFeedbackTopics(bank: string[], opts?: {
  groupsDir?: string;
  feedbackPath?: string;
}): { refreshed: boolean; count: number } {
  if (_refreshed) {
    // Return current count without re-reading
    const topics = loadFeedbackTopics(opts?.feedbackPath);
    return { refreshed: false, count: topics.length };
  }

  const groupsDir = opts?.groupsDir ?? path.join(process.cwd(), 'data', 'groups');
  const fbPath = opts?.feedbackPath ?? path.join(process.cwd(), FEEDBACK_TOPICS_PATH);

  // Find mtime of newest groups JSONL
  let newestGroupMtime = 0;
  try {
    const groups = fs.readdirSync(groupsDir);
    for (const group of groups) {
      const groupPath = path.join(groupsDir, group);
      try {
        if (!fs.statSync(groupPath).isDirectory()) continue;
        const dayFiles = fs.readdirSync(groupPath).filter(f => f.endsWith('.jsonl'));
        for (const f of dayFiles) {
          try {
            const mtime = fs.statSync(path.join(groupPath, f)).mtimeMs;
            if (mtime > newestGroupMtime) newestGroupMtime = mtime;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch {
    // groups dir missing — nothing to do
    return { refreshed: false, count: 0 };
  }

  if (newestGroupMtime === 0) {
    return { refreshed: false, count: 0 };
  }

  // Get feedback file mtime
  let feedbackMtime = 0;
  try {
    feedbackMtime = fs.statSync(fbPath).mtimeMs;
  } catch {
    // file doesn't exist — treat as stale (mtime = 0)
  }

  if (feedbackMtime >= newestGroupMtime) {
    // Feedback is fresh — no-op
    const topics = loadFeedbackTopics(fbPath);
    return { refreshed: false, count: topics.length };
  }

  // Stale — re-extract
  const topics = extractFeedbackTopics({ bank, groupsDir, feedbackPath: fbPath });
  saveFeedbackTopics(topics, fbPath);
  _refreshed = true;
  return { refreshed: true, count: topics.length };
}
