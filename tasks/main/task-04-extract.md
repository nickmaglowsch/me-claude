# Task 04: Message Extraction Module

## Objective
Create `src/extract.ts` — pure functions for filtering, per-chat stratified sampling, shuffling, volume checking, and formatting raw WhatsApp messages, with a comprehensive Vitest test suite.

## Context

**Quick Context:**
- This module has NO import of `whatsapp-web.js` — it operates on a plain `RawMessage` interface
- `RawMessage` now includes a `type` field (used in `filterMessages`)
- Sampling is per-chat (not by month) — `stratifiedSampleByChat` takes an array-of-arrays
- See `tasks/main/shared-context.md` for test infrastructure

## Requirements

### `src/extract.ts`

This module has **no import of whatsapp-web.js** at the module level. It operates on a locally-defined interface so it is fully unit-testable without any WA client.

#### Exported interface

```typescript
export interface RawMessage {
  fromMe: boolean;
  type: string;      // message type: 'chat', 'image', 'sticker', etc.
  body: string;
  author?: string;   // group message author identifier (JID)
  timestamp: number; // unix seconds
}
```

#### `export function filterMessages(messages: RawMessage[]): RawMessage[]`

Keep a message only if ALL of the following are true:
- `fromMe === true`
- `type === 'chat'` (skip media, stickers, system messages)
- `body.trim().length >= 3` (skip very short messages like "ok", "k", "kk")
- `body.trim()` is not exactly `'<Media omitted>'` (skip media placeholder strings)

Do NOT filter by numeric-only body — the spec does not require this.

#### `export function stratifiedSampleByChat(perChatMessages: RawMessage[][], perChatMax = 50): RawMessage[]`

Takes up to `perChatMax` messages from each chat's array and concatenates them.

Algorithm:
1. For each inner array in `perChatMessages`, take `array.slice(0, perChatMax)`
2. Concatenate all selections into a single flat array
3. Return the flat array (do NOT sort, do NOT shuffle — caller handles that)

Edge cases:
- Empty outer array → return `[]`
- Inner array shorter than `perChatMax` → take all of it
- `perChatMax = 0` → return `[]`

#### `export function shuffle(messages: RawMessage[]): RawMessage[]`

Applies a Fisher-Yates shuffle. Returns a NEW array (does not mutate the input).

```typescript
// Fisher-Yates:
const arr = [...messages];
for (let i = arr.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [arr[i], arr[j]] = [arr[j], arr[i]];
}
return arr;
```

#### `export function checkMinimumVolume(messages: RawMessage[]): void`

If `messages.length < 100`, throws:
```
"Not enough message history to build a reliable voice profile."
```

If length >= 100, returns without doing anything.

#### `export function formatMessagesForPrompt(messages: RawMessage[]): string`

- Maps each message to its `body` text
- Joins bodies with `"\n---\n"`
- Returns the resulting string
- Returns `""` if `messages` is empty

### `src/extract.test.ts`

All tests operate on plain `RawMessage` arrays — no WhatsApp client, no mocking.

**`filterMessages` tests:**
1. Keeps messages where `fromMe === true` and `type === 'chat'`
2. Drops messages where `fromMe === false`
3. Drops messages where `type !== 'chat'` (e.g., `'image'`, `'sticker'`)
4. Drops messages with body shorter than 3 characters (`"hi"`, `"ok"`, `"k"`)
5. Keeps messages that are exactly 3 characters (`"hey"`)
6. Drops messages with body equal to `'<Media omitted>'`
7. Does NOT drop numeric-only messages (`"123"` passes through if all other criteria met)
8. Returns empty array for empty input

**`stratifiedSampleByChat` tests:**
1. Returns all messages when each chat has fewer than `perChatMax`
2. Caps at `perChatMax` per chat — given a chat with 100 messages and `perChatMax=50`, returns 50 from that chat
3. Concatenates across multiple chats — 2 chats × 50 messages each = 100 total
4. Handles empty outer array → returns `[]`
5. Handles `perChatMax = 0` → returns `[]`

**`shuffle` tests:**
1. Returns a new array with the same elements (same length, same items when sorted)
2. Does not mutate the original array
3. Returns `[]` for empty input

**`checkMinimumVolume` tests:**
1. Does not throw when length >= 100
2. Throws with the exact error message when length < 100
3. Throws on empty array (length 0)
4. Throws on array of 99 items; does not throw on array of 100 items

**`formatMessagesForPrompt` tests:**
1. Formats a single message as its body text
2. Joins multiple messages with `"\n---\n"`
3. Returns `""` for empty array

## Existing Code References
- `tasks/main/shared-context.md` — tech stack and conventions

## Implementation Details
- `filterMessages`: use `body.trim() === '<Media omitted>'` for the exact media placeholder check
- `stratifiedSampleByChat`: use `array.slice(0, perChatMax)` — preserves original order within each chat
- `shuffle`: copy the array first (`[...messages]`) before mutating via Fisher-Yates
- `checkMinimumVolume`: throw a plain `Error` with the exact message string

## Acceptance Criteria
- [ ] `RawMessage` interface (with `type` field) exported from `src/extract.ts`
- [ ] `filterMessages` keeps only `fromMe=true`, `type='chat'`, `body.length>=3`, not `'<Media omitted>'`
- [ ] `filterMessages` does NOT drop numeric-only messages
- [ ] `stratifiedSampleByChat` takes up to `perChatMax` per inner array and concatenates
- [ ] `shuffle` returns a new array without mutating input
- [ ] `checkMinimumVolume` throws the exact error message when count < 100
- [ ] `formatMessagesForPrompt` joins bodies with `"\n---\n"`
- [ ] No import of `whatsapp-web.js` anywhere in `src/extract.ts`
- [ ] `npm test` passes with all tests green
- [ ] TypeScript compiles cleanly

## Dependencies
- Depends on: Task 01 (scaffold)
- Blocks: Task 05 (whatsapp.ts — imports `RawMessage` type), Task 06 (setup.ts)

## TDD Mode

This task uses Test-Driven Development. Write tests BEFORE implementation.

### Test Specifications
- **Test file**: `src/extract.test.ts`
- **Test framework**: Vitest
- **Test command**: `npm test` (runs `vitest run`)

### Tests to Write
1. **filterMessages — keeps valid chat msgs**: `fromMe:true, type:'chat', body:'hello'` passes
2. **filterMessages — drops non-owner**: `fromMe:false` removed
3. **filterMessages — drops non-chat type**: `type:'image'` removed even if `fromMe:true`
4. **filterMessages — drops short body**: bodies `"hi"`, `"ok"` removed; `"hey"` kept
5. **filterMessages — drops media placeholder**: `body:'<Media omitted>'` removed
6. **filterMessages — keeps numeric body**: `body:'12345'` passes (not filtered)
7. **stratifiedSampleByChat — under limit**: fewer than perChatMax per chat → all returned
8. **stratifiedSampleByChat — caps per chat**: chat with 100 msgs + perChatMax=50 → 50 returned
9. **stratifiedSampleByChat — concatenates**: 2 chats × 3 msgs, perChatMax=10 → 6 total
10. **shuffle — same elements**: shuffled array has same elements as original
11. **shuffle — no mutation**: original array unchanged after shuffle
12. **checkMinimumVolume — passes at 100**: array of 100 → no throw
13. **checkMinimumVolume — throws at 99**: array of 99 → throws with exact message
14. **formatMessagesForPrompt — single**: returns body text
15. **formatMessagesForPrompt — multiple**: joined with `"\n---\n"`
16. **formatMessagesForPrompt — empty**: returns `""`

### TDD Process
1. Write all 16 tests — they FAIL because `src/extract.ts` does not exist (RED)
2. Implement all five functions to make them pass (GREEN)
3. Run `npm test` — confirm all green, no regressions
4. Refactor if needed while keeping green

### Mocking Discipline
- Mock only at the **system boundary**: paid/external APIs, network, wall clock & randomness, destructive side effects, filesystem I/O.
- Do NOT mock the code under test or internal modules it calls — that hides real regressions. Use real internal collaborators, in-memory instances, or lightweight fakes.
- Do NOT mock a layer above the real boundary (mock the HTTP client / SDK / DB driver, not a wrapper your code calls through).
- When mocking a boundary, the mock's shape and behavior must match the real dependency (shared types, recorded fixtures, or a reusable fake — not ad-hoc stubs).

> No mocking needed — all five functions are pure. Build test data inline with plain object literals. For `shuffle`, verify correctness by comparing sorted copies, not by asserting a specific output order.
