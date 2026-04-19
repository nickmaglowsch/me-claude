# Task 01: Group message persistence layer

## Objective

Build `src/groups.ts` — the storage layer for group messages. Handles
folder naming/slugging, the `.index.json` manifest, and append-only
JSONL writes per day. No runtime wiring, no commands — those are Task 02.

## Target Files

- `src/groups.ts` (new)
- `src/groups.test.ts` (new)
- `.gitignore` (add `data/groups/`)

## Context Files

- `tasks/main/shared-context.md` — full spec (layout, naming rule, record format)
- `src/fuzzy.ts` — reuse its `normalize` function for the accent-stripping part of slug generation
- `src/memory.ts` / `src/memory-guard.ts` — atomic write pattern

## Dependencies

None.

## Requirements

### 1. Types

```typescript
export interface PersistedMessage {
  ts: string;            // ISO 8601 UTC
  local_date: string;    // YYYY-MM-DD in local time
  from_jid: string;      // sender's @c.us JID (best effort; empty string if unknown)
  from_name: string;     // pushname or number or 'Unknown'
  body: string;          // full text for chat msgs; "[image]" etc for non-chat
  from_me: boolean;
  type: string;          // "chat", "image", "audio", etc.
  id: string;            // msg.id._serialized
  has_quoted: boolean;
  quoted_id: string | null;
}

export interface GroupIndexEntry {
  name: string;          // original chat name
  folder: string;        // slugified folder name
}

export type GroupIndex = Record<string, GroupIndexEntry>; // key: chat jid
```

### 2. Path helpers

```typescript
export const GROUPS_DIR = 'data/groups';  // relative to cwd; resolve at call time
export function groupsDirAbs(): string;    // path.join(process.cwd(), GROUPS_DIR)
export function indexPath(): string;       // groups/.index.json
export function groupFolderPath(folder: string): string;
export function dayFilePath(folder: string, localDate: string): string;
```

### 3. Slugify

```typescript
// Normalize name to a safe folder name.
// Lowercase, strip accents, replace non-alphanumeric runs with "-",
// trim leading/trailing dashes, collapse repeated dashes.
// If result is empty, return the fallback argument (e.g. JID user part).
export function slugifyGroupName(name: string, fallback: string): string;
```

Reuse `src/fuzzy.ts` `normalize()` for the lowercase+accent-strip part if possible, or replicate the logic if coupling isn't wanted.

Examples:
- `"mgz"` → `"mgz"`
- `"🇧🇷 RepTime BR"` → `"reptime-br"` (emoji + space get stripped/replaced)
- `"OE - Bate papo"` → `"oe-bate-papo"`
- `"👋"`, fallback `"12345"` → `"12345"` (slug was empty, use fallback)

### 4. Index manifest I/O

```typescript
export function loadGroupIndex(): GroupIndex;
// Missing file → {}. Malformed → {} + stderr warning. Never throws.

export function saveGroupIndex(idx: GroupIndex): void;
// Atomic tmp+rename. Creates GROUPS_DIR if missing.
```

### 5. Folder assignment with collision handling

```typescript
// Looks up or creates an entry for this group JID.
// If entry exists: return existing folder.
// If not: slugify name; if slug collides with another entry's folder,
// append "-2", "-3", ... until unique; save index.
// Returns the folder name.
export function ensureGroupFolder(chatJid: string, chatName: string): string;
```

### 6. Message append

```typescript
export function localDate(tsMs: number): string;
// Returns YYYY-MM-DD in local timezone. Use toLocaleDateString('en-CA') or
// manual date assembly.

export function persistMessage(args: {
  chatJid: string;
  chatName: string;
  msg: PersistedMessage;
}): void;
// Appends one line (JSON.stringify + '\n') to dayFilePath(folder, msg.local_date).
// Creates parent dirs as needed. Uses appendFileSync (sync is fine; messages
// are infrequent enough).
// On any fs error, logs a stderr warning and returns — NEVER throws.
```

### 7. Read for summaries

```typescript
// Reads one day's JSONL for a group. Returns messages in file order.
// If file missing, returns [].
// Malformed lines are skipped with a stderr warning.
export function readDayMessages(folder: string, localDate: string): PersistedMessage[];

// List all dates we have for a group (useful for !summary date resolution).
// Returns sorted-desc list of YYYY-MM-DD strings.
export function listDays(folder: string): string[];

// Given a partial name query, return matching index entries.
// Uses fuzzy match from src/fuzzy.ts with a sensible threshold (0.4ish).
// Returns entries sorted by score desc.
export interface GroupMatch {
  jid: string;
  name: string;
  folder: string;
  score: number;
}
export function findGroupsByName(query: string): GroupMatch[];
```

### 8. Gitignore

Append `data/groups/` to `.gitignore`.

## Acceptance Criteria

- [ ] All exports listed above are present
- [ ] `slugifyGroupName` handles accents, emojis, punctuation, collisions via fallback
- [ ] `ensureGroupFolder` creates index entries on first use; returns existing on subsequent calls
- [ ] Collision between two group names that slug to the same thing → second gets `-2` suffix
- [ ] `persistMessage` appends one line per call and never throws
- [ ] `readDayMessages` roundtrip (persist then read) returns identical records
- [ ] `findGroupsByName` uses fuzzy match and returns sorted results
- [ ] `localDate` returns dates in local timezone (not UTC)
- [ ] Empty / malformed JSONL lines are handled gracefully
- [ ] `npm run build` exits 0; `npm test` — existing 196 pass, new pass too

## TDD Mode

### Test file: `src/groups.test.ts`

Same isolation pattern as `src/memory.test.ts`: tmp cwd via `fs.mkdtemp`,
`process.chdir`, cleanup in `afterEach`.

Tests to write FIRST:

**slugifyGroupName**
1. Plain lowercase: `slugifyGroupName("mgz", "fallback")` → `"mgz"`
2. Accents: `slugifyGroupName("Bate Papo", "f")` → `"bate-papo"`
3. Accents w/ diacritics: `slugifyGroupName("OE Açaí", "f")` → `"oe-acai"`
4. Emojis stripped: `slugifyGroupName("🇧🇷 RepTime BR", "f")` → `"reptime-br"`
5. Empty after normalization uses fallback: `slugifyGroupName("🎉", "12345")` → `"12345"`
6. Collapses repeats: `slugifyGroupName("a   -  b", "f")` → `"a-b"`
7. Trims leading/trailing dashes: `slugifyGroupName("---mgz---", "f")` → `"mgz"`

**Index I/O**
8. `loadGroupIndex` on missing file returns `{}`
9. `saveGroupIndex` + `loadGroupIndex` roundtrip preserves entries
10. `saveGroupIndex` creates `data/groups/` if missing
11. `saveGroupIndex` is atomic (no .tmp-* files left behind)

**ensureGroupFolder**
12. New JID: slug "mgz" → index gets entry, folder returned
13. Existing JID: returns cached folder without re-slugging
14. Collision: two JIDs, same chat name → second gets folder `"mgz-2"`
15. Three collisions: `"mgz"`, `"mgz-2"`, `"mgz-3"` in order

**persistMessage + readDayMessages**
16. Single message persisted: readDayMessages returns it
17. Multiple messages same day: order preserved
18. Messages on different days go to different files
19. Malformed JSONL line in file: readDayMessages skips with warning, returns valid ones
20. persistMessage on permission error does not throw

**listDays**
21. Empty folder: returns `[]`
22. 3 date files → returns 3 strings sorted desc

**findGroupsByName**
23. Empty index: returns `[]`
24. Exact match: query "mgz" with entry "mgz" in index → returns it with high score
25. Fuzzy match: query "reptime" with entry "RepTime BR" → matches (score > threshold)
26. No match: query "asdfgh" with unrelated entries → returns `[]`

**localDate**
27. Given a known timestamp in UTC, returns the correct local YYYY-MM-DD
    (use a date that's safely mid-day to avoid TZ edge cases)

### Mocking discipline

- Do NOT mock fs. Real temp dirs.
- Do NOT mock Date for routine tests (use actual Date.now). For localDate
  test, pass a specific ms value.

### Notes for implementer

- `findGroupsByName` threshold: 0.4 is permissive but fuzzy-matching group
  names shouldn't be too strict — users will type shorthand.
- `readDayMessages` ignores lines that fail JSON.parse; warn once per
  invocation if any were skipped.
- Consider splitting index I/O into its own private helper if repeated,
  but a single public save/load is fine.
