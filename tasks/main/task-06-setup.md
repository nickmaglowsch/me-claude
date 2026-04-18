# Task 06: Setup Entry Point

## Objective
Create `src/setup.ts` — the one-shot orchestration script that scrapes WhatsApp history from ALL chats (groups + DMs), builds a voice prompt, calls Claude, and writes `data/voice_profile.md`, then exits cleanly.

## Context

**Quick Context:**
- Setup iterates ALL chats (groups AND 1-on-1s) via `fetchAllChats` — NOT just group chats
- Output file is `data/voice_profile.md` (not project root `voice_profile.md`)
- `fetchMessages` limit per chat is **500** (matches the default)
- Template key is `MESSAGES_GO_HERE` (single-brace uppercase) passed to `fillTemplate`
- See `tasks/main/shared-context.md` for full conventions

## Requirements

### `src/setup.ts`

This is the entry point for `npm run setup`. It runs once and exits.

**Imports required:**
- `fs` from `"fs"` (for `mkdirSync`, `writeFileSync`)
- `path` from `"path"`
- `createClient`, `waitForReady`, `fetchAllChats`, `fetchMessages`, `formatRawMessage`, `getOwnerName`, `getOwnerId` from `"./whatsapp"`
- `callClaude` from `"./claude"`
- `META_PROMPT`, `fillTemplate` from `"./prompts"`
- `filterMessages`, `stratifiedSampleByChat`, `shuffle`, `checkMinimumVolume`, `formatMessagesForPrompt`, `RawMessage` from `"./extract"`

**Full execution flow (wrap in `async function main()` called immediately):**

```
1.  const client = createClient()
2.  client.initialize()
3.  console.log("Waiting for WhatsApp to be ready (scan QR code if prompted)...")
4.  await waitForReady(client)

5.  // Owner ID resolution
    const detectedId = getOwnerId(client)
    const ownerId = process.env.OWNER_ID ?? detectedId
    console.log(`Auto-detected owner ID: ${detectedId}. Using: ${ownerId}.`)

6.  const ownerName = getOwnerName(client)
    console.log(`Bot online as ${ownerName} (${ownerId})`)

7.  console.log("Fetching all chats...")
    const chats = await fetchAllChats(client)
    console.log(`Found ${chats.length} chats.`)

8.  // Collect messages per chat (for stratified sampling)
    const perChatMessages: RawMessage[][] = []
    for (const chat of chats) {
      const msgs = await fetchMessages(chat, 500)
      const raw = msgs.map(formatRawMessage)
      const filtered = filterMessages(raw)
      if (filtered.length > 0) {
        perChatMessages.push(filtered)
      }
    }
    console.log(`Collected messages from ${perChatMessages.length} chats with content.`)

9.  // Stratified sample: up to 50 per chat
    const sampled = stratifiedSampleByChat(perChatMessages, 50)
    console.log(`After stratified sampling: ${sampled.length} messages.`)

10. // Volume check — abort if insufficient history
    checkMinimumVolume(sampled)  // throws if < 100

11. // Light shuffle to avoid recency bias
    const shuffled = shuffle(sampled)

12. // Format for prompt
    const formatted = formatMessagesForPrompt(shuffled)

13. // Fill and call
    const prompt = fillTemplate(META_PROMPT, {
      MESSAGES_GO_HERE: formatted,
    })

14. console.log("Calling Claude to generate voice profile...")
    const voiceProfile = await callClaude(prompt)

15. // Write output
    const dataDir = path.join(process.cwd(), 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const outputPath = path.join(dataDir, 'voice_profile.md')
    fs.writeFileSync(outputPath, voiceProfile, "utf8")
    console.log("Voice profile written to data/voice_profile.md. Review it before going live.")

16. await client.destroy()
    process.exit(0)
```

**Error handling:** wrap `main()` call in `.catch(err => { console.error("Setup failed:", err); process.exit(1); })`.

## Existing Code References
- `src/whatsapp.ts` (Task 05 output) — `createClient`, `waitForReady`, `fetchAllChats`, `fetchMessages`, `formatRawMessage`, `getOwnerName`, `getOwnerId`
- `src/claude.ts` (Task 03 output) — `callClaude`
- `src/prompts.ts` (Task 02 output) — `META_PROMPT`, `fillTemplate`
- `src/extract.ts` (Task 04 output) — `filterMessages`, `stratifiedSampleByChat`, `shuffle`, `checkMinimumVolume`, `formatMessagesForPrompt`, `RawMessage`

## Implementation Details
- `fs.mkdirSync(dataDir, { recursive: true })` ensures `data/` exists before writing — important since it may not exist on first run
- The `checkMinimumVolume` call will throw with a clear message if not enough history — let this propagate to the `.catch()` handler so setup exits with code 1
- Log the exact string `"Voice profile written to data/voice_profile.md. Review it before going live."` on success (verbatim — runtime and setup logs have defined formats)
- Log `"Bot online as ${ownerName} (${ownerId})"` after WhatsApp is ready

## Acceptance Criteria
- [ ] `src/setup.ts` exists and is the `npm run setup` entry point
- [ ] Iterates ALL chats (groups + DMs), not just group chats
- [ ] Fetches 500 messages per chat (not 2000)
- [ ] Uses `stratifiedSampleByChat` (per-chat, not by month)
- [ ] Calls `checkMinimumVolume` and aborts with exit code 1 if fewer than 100 messages
- [ ] Calls `shuffle` before formatting
- [ ] Template filled with `{ MESSAGES_GO_HERE: formatted }` (single-brace uppercase key)
- [ ] Voice profile written to `data/voice_profile.md` (not project root)
- [ ] `data/` directory created if missing (`mkdirSync` with `recursive: true`)
- [ ] Logs `"Bot online as <ownerName> (<ownerId>)"` on ready
- [ ] Logs exact success string: `"Voice profile written to data/voice_profile.md. Review it before going live."`
- [ ] Process exits 0 on success, 1 on any uncaught error
- [ ] TypeScript compiles cleanly (`npm run build` exits 0)
- [ ] Existing `npm test` suite still passes (no regressions)

## Dependencies
- Depends on: Task 02 (prompts), Task 03 (claude), Task 04 (extract), Task 05 (whatsapp)
- Blocks: None (leaf task)

## TDD Mode
Not applicable — this task is integration-level orchestration with no pure logic of its own. All pure helpers it calls are tested in their respective tasks (02, 03, 04, 05). Acceptance is verified by manual `npm run setup` execution with a real WhatsApp session.
