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

## Contact Memory (optional)

The bot can maintain a per-contact memory file in `data/contacts/<jid>@c.us.md` that grows over time. When a memory file exists for someone in a group conversation, the bot uses it to shape tone and remember shared context (open threads, inside jokes, facts). See `docs/contact-memory.md` for the full design.

Seed memory files from your chat history (opt-in, runs one Claude call per active contact):

```bash
npm run memory:bootstrap
# With tuning flags (defaults shown):
npm run memory:bootstrap -- --top-k-chats=10 --min-messages-from-them=3 --min-messages-from-nick=3
```

Memory files are read and updated directly by Claude via filesystem tools (Read/Edit/Write/Grep/Glob) during each reply — a single subprocess call per mention. Claude decides what to read and what to update on its own. Review, edit, or delete files in `data/contacts/` at will — they're plain markdown. The entire directory is gitignored.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OWNER_ID` | Auto-detected | Your @c.us JID (e.g. `15551234567@c.us`). Override if auto-detection is wrong. Logged at startup. |
| `OWNER_LID` | (unset) | Your @lid JID (e.g. `100000000000000@lid`). WhatsApp uses this in group mentions — set it in `.env` if the bot doesn't react to @-tags in groups. |
| `BOT_DEBUG` | `0` | Set to `1` for verbose per-message logging (useful for diagnosing dropped mentions). |

Example `.env`:

```bash
OWNER_LID=100000000000000@lid
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
| `src/memory.ts` | Per-contact memory read/write + @lid → @c.us resolver |
| `src/memory-bootstrap.ts` | Seed memory files from chat history |
| `data/voice_profile.md` | Generated voice profile (gitignored) |
| `data/contacts/` | Per-contact memory files (gitignored) |
| `data/session/` | WhatsApp session data (gitignored) |
| `docs/contact-memory.md` | Design doc for the memory system (future phases) |

## Command Mode

When you send a message to **yourself** on WhatsApp starting with `!`, the bot treats it as a command rather than a mention. Commands let you teach, correct, and control the bot without editing files.

**Security model**: Command mode fires only when all three hold:
- `msg.fromMe === true` — the message comes from your own session
- The chat is your self-chat (only your JID talks to itself)
- The body starts with `!`

Messages you send in group chats or DMs to other people that start with `!` are ignored by the command gate.

### Commands

| Command | Example | Description |
|---|---|---|
| `!help` | `!help` | List all available commands |
| `!remember <jid> <fact...>` | `!remember 5511987@c.us Alice got a dog` | Append a fact to a contact's memory file (creates file if missing) |
| `!forget <jid>` | `!forget 5511987@c.us` | Delete a contact's memory file |
| `!who <jid\|name>` | `!who 5511987@c.us` or `!who Alice` | Show a contact's memory file; search by name if no JID suffix |
| `!status` | `!status` | Show bot stats for the last 24 hours |
| `!silence <chat\|all> <duration>` | `!silence mgz 2h` | Mute a specific chat or all chats; duration: `Nm`, `Nh`, `Nd` |
| `!resume` | `!resume` | Clear all silences and resume normal operation |
| `!limit <N> [group]` | `!limit 3` or `!limit 10 mgz` | Cap daily replies per group (applies to mentions, replies, and ambient). Omit the group name to set a default that applies to every group. |
| `!limit off [group]` | `!limit off mgz` | Clear the default limit, or remove a per-group override. |
| `!limit status` | `!limit status` | Show current default, per-group overrides, and today's counts. |

### Silence examples

```
!silence mgz 30m      # mute the "mgz" group for 30 minutes
!silence mgz 2h       # mute for 2 hours
!silence all 1d       # global mute for 1 day
!resume               # unmute everything immediately
```

### Limit examples

```
!limit 3              # every group independently capped at 3/day
!limit 10 mgz         # override: mgz gets 10/day
!limit 0 spammers     # kill switch for one group
!limit off mgz        # drop override (falls back to the default)
!limit status         # show config + today's counts
```

> Note: per-group limits key on the normalized chat name (lowercase + trimmed), matching `!silence` and `!ambient off`. Two groups with the same WhatsApp name share a bucket. Unnamed groups are bucketed by JID instead.

## Ambient replies (opt-in)

Beyond mention/reply triggers, the bot can chime in on plain messages
that seem to be about you or about topics you care about. Off by default.

### Enable

```
!ambient on              # turn on globally (applies to all groups you're in)
!ambient off             # master kill switch
!ambient off <chat>      # disable for a specific group
!ambient on <chat>       # re-enable for a previously-disabled group
!ambient status          # show current config
!ambient cap <n>         # change daily reply cap (default 30)
!ambient threshold <n>   # change fuzzy-match threshold, 0-1 (default 0.5)
!ambient refresh         # re-extract topics from voice profile + memory
```

### Topic list

The fuzzy-match bank is built from three sources merged together:
1. Explicit topics you add via `!topic add`
2. Auto-extracted from your voice profile (refreshed on voice-profile change)
3. Aggregated `## Recurring topics` sections across all contact memory files

```
!topic add tennis
!topic add crypto
!topic list
!topic remove tennis
```

### How it works

1. A plain message (no mention, no reply to your message) arrives in a group
2. Fuzzy-match the body against the merged topic bank
3. If score >= threshold, call claude with an ambient-flavored prompt that
   strongly prefers silence
4. Claude decides: reply or stay silent. Most of the time: silent.
5. Daily cap of 30 ambient replies prevents runaway chatter; existing 10s
   per-group rate limit still applies.

## Group message archive + summaries

The bot archives every group message it sees to disk for later lookup.

Layout:
```
data/groups/
  .index.json
  <folder>/
    YYYY-MM-DD.jsonl
```

Folder names are slugified chat names (lowercase, accent-stripped,
dash-separated). A manifest at `data/groups/.index.json` maps group JIDs
to folders. Everything under `data/groups/` is gitignored.

### !summary command

Ask the bot to summarize a group's day:

```
  !summary <group> [date]
```

Examples:

```
  !summary mgz                  # today in the mgz group
  !summary mgz yesterday
  !summary reptime 3d           # 3 days ago
  !summary oe 2026-04-15
```

Group name is fuzzy-matched. If multiple groups match, the bot lists
candidates and asks for a more specific query.

Summaries are generated by a one-shot claude call — no tools, no memory
file updates. Plain summary, bullet list of topics, optional open
threads.

## Development

```bash
npm run build      # Compile TypeScript to dist/
npm test           # Run Vitest tests
npm run test:watch # Watch mode
```
