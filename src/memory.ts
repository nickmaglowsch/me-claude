import fs from 'fs';
import path from 'path';

// Per-contact memory files live here. Filename format is "<c.us jid>.md"
// (e.g. "5511987654321@c.us.md"), matching the PRD convention. Files are
// atomically written via tmp+rename so crashes mid-write can't corrupt them.
export const CONTACTS_DIR = path.join(process.cwd(), 'data', 'contacts');

// Soft warning threshold for per-contact memory files. Under tool-access
// runtime, Claude reads only the files it wants via the Read tool, so large
// files don't blow up every prompt anymore — this is only a hint for the
// memory-update prompt to compact.
export const MAX_MEMORY_CHARS = 4096;

// Cache: @lid → @c.us resolutions, populated lazily as we see new @lid mentions.
// Cleared when the process restarts (acceptable — first reply after restart in
// a group will re-resolve, which is cheap).
const lidToCusCache = new Map<string, string>();

export function contactFilePath(cusJid: string): string {
  return path.join(CONTACTS_DIR, `${cusJid}.md`);
}

export function readContactMemory(cusJid: string): string | null {
  const filePath = contactFilePath(cusJid);
  try {
    const contents = fs.readFileSync(filePath, 'utf8');
    if (contents.length > MAX_MEMORY_CHARS * 1.5) {
      console.warn(
        `[memory] ${cusJid} is ${contents.length} chars (cap: ${MAX_MEMORY_CHARS}) — compaction recommended`,
      );
    }
    return contents;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function writeContactMemory(cusJid: string, contents: string): void {
  fs.mkdirSync(CONTACTS_DIR, { recursive: true });
  const finalPath = contactFilePath(cusJid);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

// Guarded write with corruption detection and auto git commit.
// Re-exported here for backwards-compatibility so callers can import from
// either 'memory' or 'memory-guard'. The guard module does NOT import from
// memory.ts to avoid circular dependencies — it computes its own paths.
export { writeContactMemoryGuarded } from './memory-guard';

export function listContactMemories(): string[] {
  try {
    return fs
      .readdirSync(CONTACTS_DIR)
      .filter(name => name.endsWith('@c.us.md'))
      .map(name => name.slice(0, -3));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// True if the JID looks like a canonical @c.us phone-derived identifier.
export function isCusJid(jid: string): boolean {
  return jid.endsWith('@c.us');
}

// True if the JID is a @lid opaque identifier used in group mentions.
export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

/**
 * Resolve any JID to its canonical @c.us form.
 *
 * Handles four cases:
 * - Already @c.us → returned as-is
 * - @lid seen before → returned from cache
 * - @lid not seen → walk the provided chat's participants list looking for a
 *   participant whose `lid` matches; if found, cache and return the `id`
 * - Cannot resolve → returns null (caller decides whether to skip or degrade)
 *
 * `chat` is optional — if omitted, we can't resolve @lid and return null.
 * Callers with access to a Chat object (group handler) should pass it.
 */
export function resolveToCus(jid: string, chat?: unknown): string | null {
  if (isCusJid(jid)) return jid;
  if (!isLidJid(jid)) return null;

  const cached = lidToCusCache.get(jid);
  if (cached) return cached;

  if (!chat) return null;
  const participants = (chat as { participants?: unknown[] }).participants;
  if (!Array.isArray(participants)) return null;

  for (const p of participants) {
    const participant = p as { id?: { _serialized?: string }; lid?: { _serialized?: string } | string };
    const pLid =
      typeof participant.lid === 'object'
        ? participant.lid?._serialized
        : participant.lid;
    if (pLid === jid && participant.id?._serialized) {
      const cus = participant.id._serialized;
      lidToCusCache.set(jid, cus);
      return cus;
    }
  }
  return null;
}

// Note: buildContactContext was removed when the runtime switched to
// tool-access (callClaudeWithTools). Claude now Reads contact files itself.
// readContactMemory / writeContactMemory are kept for the bootstrap script.
