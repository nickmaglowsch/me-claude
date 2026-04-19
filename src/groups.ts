import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { atomicWriteFile } from './atomic';
import { normalize, diceSimilarity } from './fuzzy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedMessage {
  ts: string;           // ISO 8601 UTC
  local_date: string;   // YYYY-MM-DD in local time
  from_jid: string;     // sender's @c.us JID (best effort; empty string if unknown)
  from_name: string;    // pushname or number or 'Unknown'
  body: string;         // full text for chat msgs; "[image]" etc for non-chat
  from_me: boolean;
  type: string;         // "chat", "image", "audio", etc.
  id: string;           // msg.id._serialized
  has_quoted: boolean;
  quoted_id: string | null;
}

export interface GroupIndexEntry {
  name: string;         // original chat name
  folder: string;       // slugified folder name
}

export type GroupIndex = Record<string, GroupIndexEntry>; // key: chat jid

export interface GroupMatch {
  jid: string;
  name: string;
  folder: string;
  score: number;
}

// ---------------------------------------------------------------------------
// Path helpers — all resolve against process.cwd() at call time so tests
// can process.chdir() into a temp directory and get correct paths.
// ---------------------------------------------------------------------------

export const GROUPS_DIR = 'data/groups';

export function groupsDirAbs(): string {
  return path.join(process.cwd(), GROUPS_DIR);
}

export function indexPath(): string {
  return path.join(groupsDirAbs(), '.index.json');
}

export function groupFolderPath(folder: string): string {
  return path.join(groupsDirAbs(), folder);
}

export function dayFilePath(folder: string, localDate: string): string {
  return path.join(groupsDirAbs(), folder, `${localDate}.jsonl`);
}

// ---------------------------------------------------------------------------
// Slugify
// ---------------------------------------------------------------------------

/**
 * Normalize a group chat name to a safe folder name.
 * Steps:
 *   1. Use fuzzy.normalize() for lowercase + accent-strip + punctuation strip
 *      (normalize also strips non-letter/digit/whitespace chars, including emojis)
 *   2. Replace whitespace runs with a single "-"
 *   3. Trim leading/trailing dashes
 *   4. Collapse repeated dashes
 *   5. If result is empty, return fallback
 */
export function slugifyGroupName(name: string, fallback: string): string {
  // normalize() lowercases, strips diacritics, strips punctuation/emoji,
  // collapses internal whitespace.
  const normed = normalize(name);

  // Replace any remaining whitespace runs with "-"
  let slug = normed.replace(/\s+/g, '-');

  // Replace any non-alphanumeric character (that isn't already a dash) with "-"
  // (handles any residual characters normalize didn't strip)
  slug = slug.replace(/[^a-z0-9-]/g, '-');

  // Collapse multiple consecutive dashes
  slug = slug.replace(/-{2,}/g, '-');

  // Trim leading/trailing dashes
  slug = slug.replace(/^-+|-+$/g, '');

  return slug.length > 0 ? slug : fallback;
}

/** Returns the first 6 hex characters of sha256(jid). */
function jidHash6(jid: string): string {
  return crypto.createHash('sha256').update(jid).digest('hex').slice(0, 6);
}

// ---------------------------------------------------------------------------
// Index manifest I/O
// ---------------------------------------------------------------------------

/** Load the group index. Missing file → {}. Malformed → {} + stderr warning. Never throws. */
export function loadGroupIndex(): GroupIndex {
  const filePath = indexPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as GroupIndex;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    console.warn(`[groups] failed to parse group index at ${filePath}:`, (err as Error).message);
    return {};
  }
}

/** Save the group index atomically (tmp+rename). Creates GROUPS_DIR if missing. */
export function saveGroupIndex(idx: GroupIndex): void {
  const dir = groupsDirAbs();
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = indexPath();
  atomicWriteFile(finalPath, JSON.stringify(idx, null, 2));
}

// ---------------------------------------------------------------------------
// Folder assignment with collision handling
// ---------------------------------------------------------------------------

/**
 * Looks up or creates an entry for this group JID.
 * - If entry exists: return existing folder.
 * - If not: slugify name; if slug collides with another entry's folder,
 *   append "-2", "-3", ... until unique; save index.
 * Returns the folder name.
 */
export function ensureGroupFolder(chatJid: string, chatName: string): string {
  const idx = loadGroupIndex();

  // Return existing entry if already registered
  if (idx[chatJid]) {
    return idx[chatJid].folder;
  }

  // Generate a unique folder name for the new JID
  const jidUserPart = chatJid.split('@')[0] ?? chatJid;
  const slugBase = slugifyGroupName(chatName, jidUserPart);
  const baseSlug = `${slugBase}-${jidHash6(chatJid)}`;

  // Collect all folders already in use
  const usedFolders = new Set(Object.values(idx).map(e => e.folder));

  let candidate = baseSlug;
  let counter = 2;
  while (usedFolders.has(candidate)) {
    candidate = `${baseSlug}-${counter}`;
    counter++;
  }

  idx[chatJid] = { name: chatName, folder: candidate };
  saveGroupIndex(idx);

  return candidate;
}

// ---------------------------------------------------------------------------
// Local date helper
// ---------------------------------------------------------------------------

/** Returns YYYY-MM-DD in local timezone for a given millisecond timestamp. */
export function localDate(tsMs: number): string {
  const d = new Date(tsMs);
  // toLocaleDateString('en-CA') returns YYYY-MM-DD in the local timezone
  return d.toLocaleDateString('en-CA');
}

// ---------------------------------------------------------------------------
// Message append
// ---------------------------------------------------------------------------

/**
 * Appends one JSONL line to the day file for the group.
 * Creates parent directories as needed.
 * On any fs error, logs a stderr warning and returns — NEVER throws.
 */
export function persistMessage(args: {
  chatJid: string;
  chatName: string;
  msg: PersistedMessage;
}): void {
  const { chatJid, chatName, msg } = args;

  try {
    const folder = ensureGroupFolder(chatJid, chatName);
    const dir = groupFolderPath(folder);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = dayFilePath(folder, msg.local_date);
    fs.appendFileSync(filePath, JSON.stringify(msg) + '\n', 'utf8');
  } catch (err) {
    console.warn('[groups] failed to persist message:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Read for summaries
// ---------------------------------------------------------------------------

/**
 * Reads one day's JSONL for a group. Returns messages in file order.
 * Missing file → []. Malformed lines skipped with a stderr warning.
 */
export function readDayMessages(folder: string, date: string): PersistedMessage[] {
  const filePath = dayFilePath(folder, date);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`[groups] failed to read day file ${filePath}:`, (err as Error).message);
    return [];
  }

  const messages: PersistedMessage[] = [];
  let skipped = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as PersistedMessage);
    } catch {
      skipped++;
    }
  }

  if (skipped > 0) {
    console.warn(`[groups] skipped ${skipped} malformed line(s) in ${filePath}`);
  }

  return messages;
}

/**
 * List all dates we have for a group (useful for !summary date resolution).
 * Returns sorted-desc list of YYYY-MM-DD strings.
 */
export function listDays(folder: string): string[] {
  const dir = groupFolderPath(folder);
  try {
    const files = fs.readdirSync(dir);
    return files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => f.replace(/\.jsonl$/, ''))
      .sort()
      .reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    console.warn(`[groups] failed to list days for ${folder}:`, (err as Error).message);
    return [];
  }
}

/**
 * Given a partial name query, return matching index entries.
 * Uses diceSimilarity from fuzzy.ts with a 0.4 threshold.
 * Returns entries sorted by score desc.
 */
export function findGroupsByName(query: string): GroupMatch[] {
  const idx = loadGroupIndex();
  const THRESHOLD = 0.4;

  const matches: GroupMatch[] = [];

  for (const [jid, entry] of Object.entries(idx)) {
    const score = diceSimilarity(query, entry.name);
    if (score >= THRESHOLD) {
      matches.push({ jid, name: entry.name, folder: entry.folder, score });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
