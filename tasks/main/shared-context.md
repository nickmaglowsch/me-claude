# Shared Context for Ambient Replies Feature

## What's being built

Add an "ambient reply" path so the bot can chime in on plain group messages
(no mention, no reply-to-Nick) when they're about Nick or topics he cares about.
Togglable via `!` commands. Off by default for all groups; once enabled
globally, applies to every group Nick is in unless a specific group is
explicitly disabled.

## Feature decisions (from 2026-04-18)

1. **Topic source**: hybrid — explicit list (managed via `!topic`) + auto-extract
   from voice profile + aggregated `## Recurring topics` sections from all
   `data/contacts/*.md` files.
2. **Daily cap**: default 30 ambient replies per day, adjustable via `!ambient cap <n>`.
3. **Per-group rate limit**: not added. Existing 10s-per-group rate limit
   (from the mention path) still applies since it reuses `lastReplyAt`.
4. **Opening style**: let voice profile govern. No hardcoded prefix.
5. **Scope**: `!ambient on` enables globally. `!ambient off <chat>` disables
   a specific group. `!ambient off` with no arg disables globally (master kill).
6. **Topic matching**: fuzzy match with confidence threshold, not substring.

## Pipeline

```
message_create, plain group message (not mention, not reply-to-Nick, not fromMe):
  └─ ambient config: masterEnabled? NO → skip
  └─ chat.name in disabledGroups? YES → skip
  └─ daily cap exceeded? YES → skip
  └─ fuzzy match body against topicBank
     (explicit + voice-profile-topics + memory-recurring-topics)
  └─ best fuzzy score < threshold → skip
  └─ call claude with AMBIENT-flavored RUNTIME_PROMPT
     (strongly prefers silence; only outputs when genuinely worth chiming in)
  └─ empty response → skip, log as "declined by model"
  └─ non-empty → send reply, record in repliesToday, log
```

## Design note: single claude call, not separate classifier

The original sketch had 2 claude calls: classifier + reply. The shipped
version uses ONE call with an AMBIENT-flavored prompt prefix that strongly
biases toward silence. Claude's existing RUNTIME_PROMPT already allows
empty output — we just make silence more likely for ambient triggers. This
halves latency and cost vs. a separate classifier step, and leverages
existing infrastructure.

## Project state (as of 2026-04-18)

- Build: `npm run build` → `tsc`, exits 0
- Tests: 139 passing across 10 files
- Source files in `src/`: claude.ts, commands.ts, events.ts, extract.ts,
  index.ts, memory-bootstrap.ts, memory-guard.ts, memory.ts, prompts.ts,
  setup.ts, stats.ts, whatsapp.ts (+ matching `.test.ts`)
- Conventions: TypeScript CommonJS, Vitest, tsx, single-brace `{KEY}`
  placeholders, atomic file writes via tmp+rename, no emojis in code.
- `data/` is the runtime root. `data/contacts/*.md` is the per-contact memory.
  `data/voice_profile.md` is the voice profile. Both gitignored.

## New files this batch introduces

- `src/fuzzy.ts` — Dice-coefficient bigram fuzzy match helper (pure function)
- `src/ambient.ts` — ambient config I/O, topic bank builder, should-reply gate
- `data/ambient-config.json` — persisted state (gitignored)

## Dependencies to add
None — all helpers are written in pure TS using node built-ins.
