# Shared Context for Improvements Batch 1

## Project State (as of 2026-04-18)

WhatsApp voice-mimicking bot with per-contact memory. Already shipped:
- Voice profile in `data/voice_profile.md`
- Per-contact memory in `data/contacts/<jid>@c.us.md`
- Runtime uses `claude -p` with tool access (Read/Edit/Write/Grep/Glob)
- Self-chat detection works (chat.id === ownerCusId)

## Key files

| File | Role |
|---|---|
| `src/index.ts` | Runtime entry, message_create handler, rate limit |
| `src/setup.ts` | One-shot voice profile generation |
| `src/memory.ts` | readContactMemory, writeContactMemory, resolveToCus |
| `src/memory-bootstrap.ts` | Seed memory files from chat history |
| `src/whatsapp.ts` | Client setup, helpers |
| `src/claude.ts` | callClaude (no tools) + callClaudeWithTools |
| `src/prompts.ts` | RUNTIME_PROMPT, META_PROMPT, MEMORY_UPDATE_PROMPT, BOOTSTRAP_PROMPT, fillTemplate |
| `src/extract.ts` | Message filtering + stratified sampling |
| `data/voice_profile.md` | Voice profile (gitignored) |
| `data/contacts/*.md` | Per-contact memory files (gitignored) |

## Conventions

- **TypeScript CommonJS.** No ESM, no `"type": "module"`. Imports compile to CJS.
- **Vitest**, tests co-located as `*.test.ts`.
- **tsx** runs source directly for dev. `tsc` compiles to `dist/`.
- **Single-brace `{KEY}` placeholders** in prompt templates. Use `fillTemplate` from `src/prompts.ts`.
- **No emojis in code or output** unless user explicitly requests.
- **Atomic file writes**: write tmp + rename. See `writeContactMemory` in `src/memory.ts` for the pattern.
- **Dotenv at entry points.** `import 'dotenv/config'` as the first line.

## Build/test commands

```bash
npm run build    # tsc → dist/
npm test         # vitest run
npm start        # runtime bot
npm run setup    # build voice profile
npm run memory:bootstrap  # seed memory files
```

## Current test count
76 tests across 6 files. All green. New tests must not break existing ones.

## Owner IDs at runtime

- `ownerCusId`: from `client.info.wid._serialized` OR `process.env.OWNER_ID` — used to identify self-chat (chat.id === ownerCusId)
- `ownerLidId`: from `process.env.OWNER_LID` — used for mention detection in groups (WhatsApp uses `@lid` in group mentions)
- `ownerIds`: `[ownerCusId, ownerLidId]` — both IDs that count as "us"

## Environment

- Runs on Linux (Ubuntu). Node 20+. git installed.
- `claude` CLI on PATH.
- whatsapp-web.js installed from github main (past v1.34.6).
- Chromium with `--no-sandbox` due to AppArmor on Ubuntu 23.10+.

## Dependency guidance

- Prefer adding no new runtime deps. Use node built-ins where possible.
- Exception: if a command-mode command needs argument parsing more complex than `.split(' ')`, still do it by hand — keep the dep list tight.
