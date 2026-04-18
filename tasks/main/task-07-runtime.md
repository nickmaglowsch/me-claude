# Task 07: Runtime Entry Point

## Objective
Create `src/index.ts` — the long-running listener that handles `message_create` events, checks if the owner is mentioned in a group chat, rate-limits replies to 10 seconds per group, waits 8 seconds, fetches before/after context windows, and calls Claude to generate a reply.

## Context

**Quick Context:**
- Rate limit is **10 seconds** per group (10,000 ms) — not 60 seconds
- Mention detection requires: `chat.isGroup === true` AND `msg.mentionedIds.includes(ownerId)` AND `msg.fromMe === false`
- Runtime fetches a CONTEXT WINDOW: up to 10 messages before the mention + up to 10 messages after (after the 8s wait)
- Template keys are uppercase single-brace: `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}`
- Voice profile is at `data/voice_profile.md` (not project root)
- See `tasks/main/shared-context.md` for full conventions

## Requirements

### `src/index.ts`

This is the entry point for `npm start`. It runs indefinitely.

**Imports required:**
- `fs` from `"fs"`
- `path` from `"path"`
- `createClient`, `waitForReady`, `getOwnerName`, `getOwnerId`, `formatMessageLine` from `"./whatsapp"`
- `callClaude` from `"./claude"`
- `RUNTIME_PROMPT`, `fillTemplate` from `"./prompts"`

**Module-level state:**

```typescript
// Rate limiter: group JID → timestamp of last reply (ms)
const lastReplyAt = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;  // 1 reply per group per 10 seconds
const AFTER_WAIT_MS = 8_000;   // wait before replying (to collect after-messages)
```

**Helper functions (export these for testability):**

```typescript
export function isMentioned(mentionedIds: string[], ownerId: string): boolean
// Returns true if ownerId is included in mentionedIds

export function isRateLimited(
  lastReplyAt: Map<string, number>,
  groupJid: string,
  nowMs: number,
  limitMs: number
): boolean
// Returns true if a prior reply exists AND (nowMs - lastReplyAt.get(groupJid)) < limitMs
// Returns false if no prior entry for groupJid (first message is never rate-limited)

export function recordReply(
  lastReplyAt: Map<string, number>,
  groupJid: string,
  nowMs: number
): void
// Sets lastReplyAt.set(groupJid, nowMs)

export function sleep(ms: number): Promise<void>
// Returns new Promise(resolve => setTimeout(resolve, ms))
```

**Startup flow (wrap in `async function main()`):**

```
1. const client = createClient()
2. client.initialize()
3. console.log("Waiting for WhatsApp to be ready (scan QR code if prompted)...")
4. await waitForReady(client)

5. // Owner ID resolution
   const detectedId = getOwnerId(client)
   const ownerId = process.env.OWNER_ID ?? detectedId
   console.log(`Auto-detected owner ID: ${detectedId}. Using: ${ownerId}.`)

6. const ownerName = getOwnerName(client)
   console.log(`Bot online as ${ownerName} (${ownerId})`)

7. // Load voice profile
   const profilePath = path.join(process.cwd(), 'data', 'voice_profile.md')
   if (!fs.existsSync(profilePath)) {
     console.error(`data/voice_profile.md not found. Run 'npm run setup' first.`)
     process.exit(1)
   }
   const voiceProfile = fs.readFileSync(profilePath, "utf8")
   console.log("Voice profile loaded.")

8. // Register message handler
   client.on("message_create", async (msg) => { ... })

9. console.log("Listening for mentions...")
```

**`message_create` handler — full logic:**

```typescript
client.on("message_create", async (msg) => {
  try {
    // Gate 1: must be in a group chat
    const chat = await msg.getChat();
    if (!chat.isGroup) return;

    // Gate 2: must not be our own message
    if (msg.fromMe) return;

    // Gate 3: we must be mentioned
    if (!isMentioned(msg.mentionedIds, ownerId)) return;

    // Gate 4: rate limit (10s per group)
    const groupJid = chat.id._serialized;
    const nowMs = Date.now();
    if (isRateLimited(lastReplyAt, groupJid, nowMs, RATE_LIMIT_MS)) return;
    recordReply(lastReplyAt, groupJid, nowMs);

    // Fetch BEFORE context: last 11 messages, exclude the mention itself
    const beforeFetch = await chat.fetchMessages({ limit: 11 });
    const beforeMessages = beforeFetch
      .filter(m => m.id._serialized !== msg.id._serialized)
      .slice(-10);  // up to 10, most recent

    // Wait 8 seconds for possible "after" messages
    await sleep(AFTER_WAIT_MS);

    // Fetch AFTER context: messages that arrived after the mention's timestamp
    const afterFetch = await chat.fetchMessages({ limit: 20 });
    const afterMessages = afterFetch
      .filter(m => m.timestamp > msg.timestamp && m.id._serialized !== msg.id._serialized)
      .slice(0, 10);  // up to 10

    // Helper: format a message line (requires resolving sender name)
    const formatLine = async (m: any): Promise<string> => {
      const contact = await m.getContact();
      const senderName = contact.pushname || contact.number || "Unknown";
      return formatMessageLine(m, senderName);
    };

    // Format mention sender
    const mentionContact = await msg.getContact();
    const mentionSenderName = mentionContact.pushname || mentionContact.number || "Someone";

    // Format all message lines
    const beforeLines = await Promise.all(beforeMessages.map(formatLine));
    const afterLines = await Promise.all(afterMessages.map(formatLine));
    const mentionLine = formatMessageLine(msg, mentionSenderName);

    // Build prompt vars
    const vars = {
      VOICE_PROFILE_GOES_HERE: voiceProfile,
      BEFORE_MESSAGES: beforeLines.length > 0 ? beforeLines.join('\n') : '(no messages before)',
      MENTION_MESSAGE: mentionLine,
      AFTER_MESSAGES: afterLines.length > 0 ? afterLines.join('\n') : '(no messages after yet)',
    };

    const response = await callClaude(fillTemplate(RUNTIME_PROMPT, vars));
    const reply = response.trim();

    // Silence is allowed — if Claude returns empty, skip
    if (!reply) return;

    await msg.reply(reply);

    // Log the handled mention
    console.log(`[${chat.name}] ${mentionSenderName}: ${msg.body} -> ${reply}`);
  } catch (err) {
    console.error("Error handling message:", err);
  }
});
```

Call `main().catch(err => { console.error("Fatal error:", err); process.exit(1); })`.

Do NOT call `process.exit(0)` anywhere in the runtime — it runs until killed.

### `src/index.test.ts`

Test ONLY the four exported pure helpers. Do not test `main()` or any WhatsApp client interaction.

**`isMentioned` tests:**
1. Returns `true` when `ownerId` is in `mentionedIds`
2. Returns `false` when `ownerId` is not in `mentionedIds`
3. Returns `false` when `mentionedIds` is empty

**`isRateLimited` tests:**
1. Returns `true` when last reply was less than `limitMs` ago (e.g., 5s ago, limit 10s)
2. Returns `false` when last reply was more than `limitMs` ago (e.g., 15s ago, limit 10s)
3. Returns `false` when there is no entry for the group (first message ever in that group)

**`recordReply` tests:**
1. Sets the timestamp in the map for the given group JID
2. Overwrites an existing entry with the new timestamp

**`sleep` tests:**
1. Resolves after approximately the specified delay (use 50ms; assert elapsed >= 40ms)

## Existing Code References
- `src/whatsapp.ts` (Task 05 output) — `createClient`, `waitForReady`, `getOwnerName`, `getOwnerId`, `formatMessageLine`
- `src/claude.ts` (Task 03 output) — `callClaude`
- `src/prompts.ts` (Task 02 output) — `RUNTIME_PROMPT`, `fillTemplate`

## Implementation Details
- `chat.id._serialized` is the group JID string used as the rate-limiter key
- `chat.fetchMessages({ limit: 11 })` fetches the 11 most recent messages; filtering out the mention itself leaves up to 10 "before" messages
- After the 8s wait, `chat.fetchMessages({ limit: 20 })` fetches the 20 most recent; keep only those with `timestamp > msg.timestamp` → these are the "after" messages
- `msg.reply(text)` sends the reply in-thread (as a reply to the mention message specifically — not a standalone message)
- Empty `reply` (whitespace-only) must be silently skipped — do NOT call `msg.reply("")`
- Rate limit constant is `10_000` ms (10 seconds), not 60 seconds

## Acceptance Criteria
- [ ] `isMentioned`, `isRateLimited`, `recordReply`, `sleep` are exported from `src/index.ts`
- [ ] Mention detection checks `chat.isGroup === true` (via `msg.getChat()`)
- [ ] Mention detection checks `msg.fromMe === false`
- [ ] Mention detection checks `msg.mentionedIds.includes(ownerId)`
- [ ] Rate limit is 10 seconds (10,000 ms) per group — NOT 60 seconds
- [ ] Before-context: up to 10 messages before mention fetched via `chat.fetchMessages({ limit: 11 })`
- [ ] 8-second wait happens before fetching after-context
- [ ] After-context: up to 10 messages with timestamp > mention's timestamp
- [ ] Template filled with `{ VOICE_PROFILE_GOES_HERE, BEFORE_MESSAGES, MENTION_MESSAGE, AFTER_MESSAGES }` (uppercase, single-brace)
- [ ] Empty response from Claude → silent skip (no `msg.reply` called)
- [ ] `msg.reply(reply)` used (not `chat.sendMessage`)
- [ ] Log format on success: `[<group name>] <sender>: <mention body> -> <reply body>`
- [ ] `data/voice_profile.md` missing → logs helpful error and exits 1
- [ ] Startup logs `Bot online as <ownerName> (<ownerId>)`
- [ ] `npm test` passes with all tests green
- [ ] Existing tests (tasks 02–05) still pass
- [ ] TypeScript compiles cleanly

## Dependencies
- Depends on: Task 02 (prompts), Task 03 (claude), Task 05 (whatsapp)
- Blocks: None (leaf task)

## TDD Mode

This task uses Test-Driven Development for the four exported pure helpers.

### Test Specifications
- **Test file**: `src/index.test.ts`
- **Test framework**: Vitest
- **Test command**: `npm test` (runs `vitest run`)

### Tests to Write
1. **isMentioned — match**: `["id1", "id2"]` with `ownerId = "id1"` → `true`
2. **isMentioned — no match**: `["id2"]` with `ownerId = "id1"` → `false`
3. **isMentioned — empty**: `[]` with any `ownerId` → `false`
4. **isRateLimited — within window**: last reply 5s ago, limit 10s → `true`
5. **isRateLimited — outside window**: last reply 15s ago, limit 10s → `false`
6. **isRateLimited — no prior entry**: no entry in map → `false`
7. **recordReply — sets entry**: after call, map has correct timestamp
8. **recordReply — overwrites**: second call updates timestamp
9. **sleep — resolves after delay**: 50ms sleep takes >= 40ms

### TDD Process
1. Write the 9 tests above — they FAIL because the helpers don't exist yet (RED)
2. Implement the four helper functions in `src/index.ts` (export them) (GREEN)
3. Then implement the `main()` function and `message_create` handler — untested orchestration using only tested primitives
4. Run `npm test` — confirm all 9 tests green, no regressions in other files
5. Refactor while keeping green

### Mocking Discipline
- Mock only at the **system boundary**: paid/external APIs, network, wall clock & randomness, destructive side effects, filesystem I/O.
- Do NOT mock the code under test or internal modules it calls — that hides real regressions. Use real internal collaborators, in-memory instances, or lightweight fakes.
- Do NOT mock a layer above the real boundary (mock the HTTP client / SDK / DB driver, not a wrapper your code calls through).
- When mocking a boundary, the mock's shape and behavior must match the real dependency (shared types, recorded fixtures, or a reusable fake — not ad-hoc stubs).

> The `sleep` test exercises real timer behavior (50ms) — do not mock `setTimeout`. The `Map` passed to `isRateLimited` and `recordReply` tests is created inline as a real `Map` — no mocking of module state.
