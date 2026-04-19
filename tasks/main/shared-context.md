# Shared Context for Group Message Archive + Summary Command

## What's being built

1. Persist every group message the bot sees to disk, as JSONL files
   organized by group folder + date.
2. New `!summary <group> [date]` command (in self-chat) that reads the
   relevant JSONL, calls claude, and replies with a summary.

## Layout

```
data/groups/
  .index.json           # { "<group-jid>@g.us": { "name": "mgz", "folder": "mgz" } }
  mgz/
    2026-04-18.jsonl
    2026-04-19.jsonl
  reptime-br/
    2026-04-18.jsonl
```

Each JSONL line:
```json
{"ts":"2026-04-18T14:32:11.000Z","local_date":"2026-04-18","from_jid":"5511...@c.us","from_name":"Alice","body":"hey","from_me":false,"type":"chat","id":"msg-id","has_quoted":false,"quoted_id":null}
```

Local date is pre-computed so file placement is deterministic. ISO ts in
UTC preserved for ordering.

## Folder naming rule

Normalize the chat name:
- lowercase
- strip accents using same mapping as `src/fuzzy.ts` normalize (reuse it)
- replace any non-alphanumeric run with a single `-`
- trim leading/trailing dashes
- collapse multiple dashes

If normalized is empty (all-emoji chat name), fall back to the group's
JID user part (digits before `@g.us`).

Collisions: append `-2`, `-3`, etc. based on what's already in the
index. Track all mappings in `data/groups/.index.json`.

## Command spec

```
!summary <group> [date]

group: fuzzy-match against known group names from the index.
  Multiple matches → reply with candidates, ask for more specific.
  Zero matches → reply "no group matching <query>".
  One match → proceed.

date:
  today (default)
  yesterday
  Nd      (N days ago, e.g. 2d → day before yesterday)
  YYYY-MM-DD

Examples:
!summary mgz
!summary mgz yesterday
!summary reptime 3d
!summary "oe reborn" 2026-04-15
```

Output: multi-line reply, plain summary. No explicit voice-profile
application — this is a meta-utility.

## When to persist

At the TOP of the `message_create` handler, right after `chat.isGroup`
is confirmed true, BEFORE fromMe / mention / rate-limit gates. We want
every chat message archived — including Nick's own — so summaries have
complete context.

Persistence failures must be non-fatal. Log a warning, continue the
handler.

## Message types to persist

- `type === 'chat'` → body populated, full record
- Other types (image, sticker, audio, ptt, etc.) → record with
  `body: "[<type>]"` or similar, type field set correctly
- System messages (e.g. "Alice added Bob") → skip entirely

## Project state

- 196 tests passing across 12 files, `tsc` clean.
- Files in src/: ambient.ts, claude.ts, commands.ts, events.ts, extract.ts,
  fuzzy.ts, index.ts, memory-bootstrap.ts, memory-guard.ts, memory.ts,
  prompts.ts, setup.ts, stats.ts, whatsapp.ts (+ matching .test.ts for
  most).
- Conventions: TypeScript CommonJS, Vitest, tsx, atomic writes via
  tmp+rename, single-brace `{KEY}` placeholders.

## Dependencies

No new npm deps. Use node built-ins only.
