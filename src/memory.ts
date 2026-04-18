import fs from 'fs';
import path from 'path';

// Per-contact memory files live here. Filename format is "<c.us jid>.md"
// (e.g. "5511987654321@c.us.md"), matching the PRD convention. Files are
// atomically written via tmp+rename so crashes mid-write can't corrupt them.
export const CONTACTS_DIR = path.join(process.cwd(), 'data', 'contacts');

// Max size for a single contact memory file injected into the runtime prompt.
// When a file exceeds this, we log a warning at read time; auto-compaction is
// deferred per the design doc.
export const MAX_MEMORY_CHARS = 3072;

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

// Build the CONTACT_CONTEXT block for the runtime prompt. Returns empty string
// when no files were found for any of the given JIDs — callers pass that
// through to the template to drop the block entirely.
export function buildContactContext(cusJids: string[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const jid of cusJids) {
    if (seen.has(jid)) continue;
    seen.add(jid);
    const contents = readContactMemory(jid);
    if (!contents) continue;
    const clipped = contents.length > MAX_MEMORY_CHARS
      ? contents.slice(0, MAX_MEMORY_CHARS) + '\n\n[...truncated]'
      : contents;
    blocks.push(clipped);
  }
  if (blocks.length === 0) return '';
  return [
    '# PEOPLE YOU KNOW',
    '',
    'Below is what you remember about the people in this chat. Use this to',
    'pick tone and reference shared context. Do not recite these facts',
    'unprompted — use them to shape how you respond.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}
