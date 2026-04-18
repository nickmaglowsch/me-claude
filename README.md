# WhatsApp AI Voice Bot

A Node.js/TypeScript bot that listens for WhatsApp group mentions and replies in your own voice, using a Claude-generated voice profile built from your real message history.

## Prerequisites

- Node.js 20+
- The `claude` CLI binary on your `PATH` (authenticated and working — run `claude --version` to verify)
- A WhatsApp account accessible from this machine

## Installation

```bash
npm install
```

## Setup — Generate Voice Profile

Setup scrapes your WhatsApp history from all chats (groups and DMs) and calls Claude to build a personalized voice profile saved to `data/voice_profile.md`.

```bash
npm run setup
```

What happens during setup:

1. A QR code is printed to the terminal — scan it with WhatsApp on your phone (first run only; session is saved to `data/session/` for future runs)
2. The script fetches all chat history (groups + DMs), filters to your own messages, and takes a stratified sample
3. If fewer than 100 of your messages are found, setup aborts with an error — you need more chat history
4. Claude generates `data/voice_profile.md` — a detailed profile of your writing style
5. The script exits — review the file before going live

> Note: `data/voice_profile.md` is gitignored — it contains your personal message data.

## Runtime — Start the Bot

```bash
npm start
```

What happens at runtime:

- QR scan (first run) or auto-reconnect (subsequent runs via saved session in `data/session/`)
- The bot listens for group messages that mention you
- When mentioned: waits 8 seconds (to catch any follow-up messages in the thread), then calls Claude with the full before/after context window and sends a reply in your voice
- Rate-limited to once per 10 seconds per group to avoid flooding

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNER_ID` | Auto-detected | Your WhatsApp JID (e.g. `15551234567@c.us`). Override if auto-detection is wrong. Logged at startup. |

Example:

```bash
OWNER_ID=15551234567@c.us npm start
```

## Architecture

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

## Development

```bash
npm run build      # Compile TypeScript to dist/
npm test           # Run Vitest tests
npm run test:watch # Watch mode
```
