# Task 02: Structured events + `npm run stats`

## Objective

Replace scattered `console.log` calls with a structured event logger that
writes JSONL to `data/events.jsonl`. Add `npm run stats` that parses the
log and reports replies-per-day, cost estimate, skip breakdown, and
slowest claude calls.

Human-readable stdout logs STAY — we add structured logs in parallel, not
as a replacement. Both go out.

## Target Files

- `src/events.ts` (new)
- `src/events.test.ts` (new)
- `src/stats.ts` (new — the stats runner)
- `src/stats.test.ts` (new)
- `src/index.ts` (add event logging calls at key sites)
- `src/claude.ts` (measure duration, emit event)
- `src/memory.ts` or wherever writes happen (emit memory events)
- `src/memory-bootstrap.ts` (emit bootstrap events)
- `package.json` (add `"stats": "tsx src/stats.ts"`)
- `.gitignore` (add `data/events.jsonl`)

## Context Files

- `tasks/main/shared-context.md`
- `src/index.ts` — current `console.log` sites in the handler
- `src/claude.ts` — current subprocess wrapper (add timing)
- `docs/architecture-improvements.md` — item 4 specification

## Dependencies

None. Can run in parallel with task 01.

## Requirements

### 1. `src/events.ts` — event logger module

Export:

```typescript
export type EventKind =
  | 'reply.sent'
  | 'reply.silent'       // claude returned empty; skipped
  | 'skip.not_in_group'
  | 'skip.from_me'
  | 'skip.not_mentioned'
  | 'skip.rate_limited'
  | 'skip.get_chat_failed'
  | 'command.received'
  | 'command.executed'
  | 'command.failed'
  | 'memory.written'
  | 'memory.rejected'
  | 'memory.git_failed'
  | 'bootstrap.contact_written'
  | 'bootstrap.contact_skipped'
  | 'claude.call'        // any claude subprocess call
  | 'error';

export interface EventBase {
  ts: string;            // ISO 8601
  kind: EventKind;
  chat?: string;         // human-readable chat name if applicable
  chat_id?: string;      // JID
  sender_name?: string;
  sender_jid?: string;
  trigger?: 'mention' | 'reply';
  duration_ms?: number;
  tokens_in?: number;    // populated when parseable
  tokens_out?: number;
  cost_usd?: number;     // computed from tokens if available
  reason?: string;       // freeform, for skips/errors
  [key: string]: unknown; // allow kind-specific fields
}

export function logEvent(event: Omit<EventBase, 'ts'>): void;
export function getEventsPath(): string;
export const EVENTS_FILE: string; // "data/events.jsonl"
```

`logEvent` appends one JSON line to `data/events.jsonl`. Creates the
parent `data/` dir if missing. Never throws — on IO failure, write a
console.warn and continue.

Use `process.cwd()` + `data/events.jsonl` for the path. Keep it simple.

### 2. Instrumentation sites

Add `logEvent(...)` calls at these specific sites:

- **`src/index.ts` handler** (after existing debug logs, in parallel):
  - After `if (!chat.isGroup)` skip → `kind: 'skip.not_in_group'`
  - After `if (msg.fromMe)` skip → `kind: 'skip.from_me'`
  - After `if (!trigger)` skip → `kind: 'skip.not_mentioned'`
  - After rate-limit skip → `kind: 'skip.rate_limited'`
  - After `msg.reply(reply)` → `kind: 'reply.sent'` with duration_ms from the claude call, trigger, chat, sender
  - When claude returns empty → `kind: 'reply.silent'`
  - In the outer catch → `kind: 'error'`, reason = err.message

- **`src/claude.ts` inside `runClaude`**:
  - On successful close → `kind: 'claude.call'`, duration_ms, tool/non-tool variant in a `variant` field
  - On timeout or non-zero exit → `kind: 'error'`, reason

- **`src/memory-bootstrap.ts`**:
  - On successful write → `kind: 'bootstrap.contact_written'`, sender_jid, duration_ms
  - On any skip reason → `kind: 'bootstrap.contact_skipped'`, reason

### 3. Token & cost extraction

The `claude -p` CLI with `--output-format json` emits usage info. For the
text mode we use, it does NOT. Therefore cost/token fields will often be
undefined — that's fine. Just don't crash when they're missing.

Future task can switch to JSON output format to capture this.

For now: `tokens_in`, `tokens_out`, `cost_usd` are always undefined in
emitted events. Stats runner handles that gracefully (reports "n/a").

### 4. `src/stats.ts` — the runner

Read `data/events.jsonl` line-by-line, parse each JSON object, ignore
lines that fail to parse (log a warning to stderr but keep going).

Accept a `--window` flag (default: `24h`). Supported: `24h`, `7d`, `30d`, `all`.

Output to stdout:

```
=== WhatsApp bot stats (window: 24h) ===

Replies:             12
  by trigger:        mention=9 reply=3
  by group:          mgz=6 reptime=3 OE=3
Silent (empty):      2
Skips (total):       148
  by reason:         rate_limited=4 not_mentioned=140 not_in_group=4
Errors:              1
  Most recent:       "getChat failed: timeout after 30s" @ 14:23

Memory updates:      8 written, 0 rejected
Bootstrap:           n/a (no bootstrap events in window)

Claude calls:        14 total
  avg duration:      22.4s
  p50 / p95 / p99:   18s / 42s / 52s
  slowest:           54s on reply.sent in mgz @ 14:47

Commands:            3 executed, 0 failed
  Most recent:       !status @ 15:01

Cost estimate:       n/a (tokens not captured; run with --output-format json to enable)
```

Format can be simpler if time-constrained, but hit at least: reply count,
skip breakdown, error count, claude-call duration stats.

### 5. `package.json` and `.gitignore`

- Add `"stats": "tsx src/stats.ts"` to scripts
- Add `data/events.jsonl` to `.gitignore` (events contain PII)

## Acceptance Criteria

- [ ] `src/events.ts` exports `logEvent`, `EventKind`, `EventBase`, `EVENTS_FILE`
- [ ] `logEvent` appends JSONL to `data/events.jsonl`, creates parent dir, never throws
- [ ] Every `console.log` for reply/skip/memory sites is PARALLELED by a `logEvent` call (console output stays for human readability)
- [ ] `src/stats.ts` parses the file and prints the spec above to stdout
- [ ] `npm run stats` works; default window is 24h; `--window 7d` and `--window all` supported
- [ ] `package.json` has the new script; `.gitignore` has `data/events.jsonl`
- [ ] Existing tests still pass
- [ ] New tests for event emit + read roundtrip, window filtering, skip aggregation, duration percentile calc
- [ ] `npm run build` exits 0; `npm test` green

## TDD Mode

### Test files

- `src/events.test.ts` — event logging
- `src/stats.test.ts` — stats aggregation

### Tests for events.test.ts:

1. **logEvent appends a line**: call once, read file, parse JSON, assert fields
2. **logEvent adds timestamp**: `ts` field is populated with a valid ISO string
3. **logEvent multiple calls produce multiple lines**: 3 calls → 3 lines in the file
4. **logEvent survives missing parent dir**: delete data/, call logEvent, file exists afterward
5. **logEvent does not throw on IO error**: make data/events.jsonl a directory (can't write a file with that name) → function does not throw, writes warning to stderr

### Tests for stats.test.ts:

Write a helper that generates a synthetic events.jsonl from a list of event objects, then run the stats logic against it.

1. **Empty file → empty-but-valid output**: no events → stats still prints headers with zero counts
2. **Counts replies correctly**: 3 `reply.sent` events → reports 3
3. **Groups by trigger**: 2 mention + 1 reply → reports `mention=2 reply=1`
4. **Skip breakdown by reason**: 5 rate_limited + 10 not_mentioned → reports both counts
5. **Window filter — 24h**: events 25h ago are excluded
6. **Window filter — 7d**: events 8d ago are excluded, events 6d ago are included
7. **Window filter — all**: nothing is excluded
8. **Duration percentiles**: synthetic durations [10, 20, 30, 40, 50] → p50=30, p95≈48, p99≈49 (approximate is fine; assert within tolerance)
9. **Malformed line is skipped**: file with one good line + one bad line → reports counts for the good one, doesn't crash

### Mocking discipline

- Don't mock fs; use temp dirs.
- Don't mock Date in instrumentation-adjacent tests — use `Date.now()` freely.
- For window-filter tests, generate events with explicit `ts` values (stringified ISO dates) to control the clock without mocking it.
