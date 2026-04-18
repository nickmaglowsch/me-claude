# Task 08: README

## Objective
Write the project `README.md` documenting prerequisites, installation, setup, runtime operation, configuration, and architecture.

## Context

**Quick Context:**
- Voice profile lives at `data/voice_profile.md` (not project root)
- Session data lives at `data/session/` (not `.wwebjs_auth/`)
- Rate limit is 10 seconds per group mention
- See `tasks/main/shared-context.md` for full tech stack

## Requirements

The README must include the following sections in order:

### 1. Title and one-line description
`# WhatsApp AI Voice Bot`
One sentence: what the bot does.

### 2. Prerequisites
- Node.js 20+
- The `claude` CLI binary on your `PATH` (authenticated and working — run `claude --version` to verify)
- A WhatsApp account accessible from this machine

### 3. Installation
```bash
npm install
```

### 4. Setup — Generate Voice Profile
Explain that setup scrapes WhatsApp history from all chats (groups and DMs) and calls Claude to build a voice profile.

```bash
npm run setup
```

Steps the user sees:
1. QR code printed to terminal → scan with WhatsApp on phone (first run only; session saved to `data/session/`)
2. Script fetches all chat history (groups + DMs), filters and samples messages
3. If fewer than 100 of your messages are found, setup aborts with an error — you need more history
4. Claude generates `data/voice_profile.md`
5. Script exits — review the file before going live

Note: `data/voice_profile.md` is gitignored — it contains your personal message data.

### 5. Runtime — Start the Bot
```bash
npm start
```

What happens:
- QR scan (first run) or auto-reconnect (subsequent runs via saved session in `data/session/`)
- Bot listens for group messages that mention you
- When mentioned: waits 8 seconds (to catch follow-up messages), then calls Claude with the full context window, sends reply
- Rate-limited to once per 10 seconds per group

### 6. Configuration
| Variable | Default | Description |
|----------|---------|-------------|
| `OWNER_ID` | Auto-detected | Your WhatsApp JID (e.g. `15551234567@c.us`). Override if auto-detection is wrong. Logged at startup. |

Example:
```bash
OWNER_ID=15551234567@c.us npm start
```

### 7. Architecture

Brief file map:

| File | Role |
|------|------|
| `src/index.ts` | Runtime entry — group mention listener |
| `src/setup.ts` | Setup entry — voice profile generator |
| `src/whatsapp.ts` | WhatsApp client helpers |
| `src/claude.ts` | Claude CLI subprocess wrapper |
| `src/prompts.ts` | Prompt templates and `fillTemplate` helper |
| `src/extract.ts` | Message filtering and per-chat stratified sampling |
| `data/voice_profile.md` | Generated voice profile (gitignored) |
| `data/session/` | WhatsApp session data (gitignored) |

### 8. Development

```bash
npm run build      # Compile TypeScript to dist/
npm test           # Run Vitest tests
npm run test:watch # Watch mode
```

## Existing Code References
- `tasks/main/shared-context.md` — tech stack and conventions
- `tasks/main/updated-prd.md` — full architecture overview

## Implementation Details
- Reflect the actual file layout: `data/voice_profile.md` and `data/session/`, not root-level paths
- Mention the 8-second after-wait and 10-second rate limit in the Runtime section so users understand the timing behavior

## Acceptance Criteria
- [ ] `README.md` exists at project root
- [ ] All 8 sections listed above are present
- [ ] `npm run setup` and `npm start` commands are clearly shown
- [ ] `data/voice_profile.md` path is correct (not `voice_profile.md` at root)
- [ ] `data/session/` path is correct (not `.wwebjs_auth/`)
- [ ] `OWNER_ID` env var is documented with an example
- [ ] Architecture file map is present
- [ ] No placeholder text like `[TODO]` or `<fill in>` remains
- [ ] TypeScript compiles cleanly (README does not affect compilation, but run `npm run build` as a sanity check)

## Dependencies
- Depends on: Task 01 (scaffold — must exist to know the final file layout)
- Blocks: None (documentation; does not affect other tasks functionally)

## TDD Mode
Not applicable — this task produces only documentation.
