# Task 05: WhatsApp Client Helpers

## Objective
Create `src/whatsapp.ts` — client initialization, session management, and helper functions for fetching chats/messages and formatting them. Test only the pure formatting helpers (no real WA client in tests).

## Context

**Quick Context:**
- `LocalAuth` must be initialized with `dataPath: 'data/session/'` (not the default `.wwebjs_auth/`)
- `fetchMessages` default limit is **500** (not 2000)
- `fetchAllChats` returns ALL chats (groups + DMs) — used by setup
- `formatMessageLine` is a new pure helper: formats `[HH:MM] SenderName: body`
- `RawMessage` now has a `type` field — `formatRawMessage` must map it
- See `tasks/main/shared-context.md` for test infrastructure

## Requirements

### `src/whatsapp.ts`

Import `Client`, `LocalAuth`, `Message`, `Chat` from `whatsapp-web.js`. Import `RawMessage` from `./extract`.

#### `export function createClient(): Client`

- Creates a `new Client({ authStrategy: new LocalAuth({ dataPath: 'data/session/' }) })`
- Registers a `qr` handler: `client.on("qr", qr => require("qrcode-terminal").generate(qr, { small: true }))`
  - Use `require("qrcode-terminal")` at call time (avoids TypeScript type issues with this package)
- Registers an `auth_failure` handler: log the error message to `console.error` and call `process.exit(1)`
- Does NOT call `client.initialize()` — the caller is responsible
- Returns the client instance

#### `export function waitForReady(client: Client): Promise<void>`

- Returns a Promise that resolves when the `ready` event fires on `client`
- If the `ready` event does not fire within 120,000 ms, rejects with: `"WhatsApp client did not become ready within 120s"`
- Clears the timeout if `ready` fires before the deadline

#### `export async function fetchAllChats(client: Client): Promise<Chat[]>`

- Calls `await client.getChats()`
- Returns ALL chats — no filtering (includes both group chats and 1-on-1s)
- Used by setup to iterate over all available message history

#### `export async function fetchGroupChats(client: Client): Promise<Chat[]>`

- Calls `await client.getChats()`
- Filters to chats where `chat.isGroup === true`
- Returns the filtered array

#### `export async function fetchMessages(chat: Chat, limit = 500): Promise<Message[]>`

- Calls `await chat.fetchMessages({ limit })`
- Default `limit`: **500**
- Returns the result

#### `export function formatMessageLine(msg: Message, senderName: string): string`

Pure function. Formats a message as `[HH:MM] SenderName: body`.

```typescript
const d = new Date(msg.timestamp * 1000);
const hh = String(d.getHours()).padStart(2, '0');
const mm = String(d.getMinutes()).padStart(2, '0');
return `[${hh}:${mm}] ${senderName}: ${msg.body}`;
```

This function is tested directly. Use local time (not UTC) for `getHours`/`getMinutes`.

#### `export function formatRawMessage(msg: Message): RawMessage`

- Maps a `whatsapp-web.js` `Message` to the local `RawMessage` interface:
  ```typescript
  {
    fromMe:    msg.fromMe,
    type:      msg.type,
    body:      msg.body,
    author:    msg.author ?? undefined,
    timestamp: msg.timestamp,
  }
  ```
- Pure function given a Message object

#### `export function getOwnerName(client: Client): string`

- Returns `client.info.pushname` if truthy, otherwise returns `"Owner"`

#### `export function getOwnerId(client: Client): string`

- Returns `client.info.wid._serialized`

### `src/whatsapp.test.ts`

Test ONLY the pure helper functions. Do NOT instantiate a real WhatsApp client in tests.

**`formatMessageLine` tests:**
1. Produces `[HH:MM] SenderName: body` with correct zero-padding for hours and minutes
2. Uses `senderName` parameter verbatim in the output
3. Uses `msg.body` verbatim in the output

**`formatRawMessage` tests:**
1. Maps `fromMe`, `type`, `body`, `timestamp` correctly from a plain object shaped like `Message`
2. Maps `author` when present
3. Sets `author` to `undefined` when `msg.author` is null/undefined

**`getOwnerName` tests:**
1. Returns `pushname` when truthy
2. Returns `"Owner"` when `pushname` is falsy (`""`, `undefined`, `null`)

**`getOwnerId` tests:**
1. Returns `wid._serialized` from the client info

> For these tests, pass plain mock objects (typed as `any` or cast) — do not mock the `whatsapp-web.js` module.

## Existing Code References
- `src/extract.ts` (Task 04 output) — imports `RawMessage` type from here
- `tasks/main/shared-context.md` — tech stack and conventions

## Implementation Details
- `formatMessageLine` uses `new Date(msg.timestamp * 1000)` — timestamp is unix seconds, multiply by 1000 for ms
- `getHours()` and `getMinutes()` return local time (not UTC) — this is correct for display purposes
- For the test of `formatMessageLine`, construct a plain object with a known `timestamp`, then verify the output string matches the expected `[HH:MM] Name: body` format

## Acceptance Criteria
- [ ] `createClient()` uses `LocalAuth({ dataPath: 'data/session/' })` (not default path)
- [ ] `waitForReady()` rejects after 120s if no `ready` event fires
- [ ] `fetchAllChats()` returns ALL chats (no filtering)
- [ ] `fetchGroupChats()` filters to group chats only
- [ ] `fetchMessages()` calls `chat.fetchMessages({ limit })` with default limit of 500
- [ ] `formatMessageLine()` returns `[HH:MM] SenderName: body` format with zero-padded hours/minutes
- [ ] `formatRawMessage()` maps all five fields including `type`
- [ ] `getOwnerName()` falls back to `"Owner"` when `pushname` is falsy
- [ ] `getOwnerId()` returns `client.info.wid._serialized`
- [ ] `npm test` passes with all formatting/helper tests green
- [ ] TypeScript compiles cleanly

## Dependencies
- Depends on: Task 01 (scaffold), Task 04 (extract.ts — for `RawMessage` type)
- Blocks: Task 06 (setup.ts), Task 07 (index.ts)

## TDD Mode

This task uses Test-Driven Development for the pure helper functions only.

### Test Specifications
- **Test file**: `src/whatsapp.test.ts`
- **Test framework**: Vitest
- **Test command**: `npm test` (runs `vitest run`)

### Tests to Write
1. **formatMessageLine — output format**: given known timestamp + senderName + body → correct `[HH:MM] Name: body`
2. **formatMessageLine — zero-padding**: single-digit hour or minute is zero-padded (e.g., `[09:05]`)
3. **formatRawMessage — base fields**: `fromMe`, `type`, `body`, `timestamp` map correctly
4. **formatRawMessage — author present**: `author` field mapped
5. **formatRawMessage — author absent**: `author` is `undefined`
6. **getOwnerName — has pushname**: returns `pushname`
7. **getOwnerName — no pushname**: returns `"Owner"`
8. **getOwnerId**: returns `wid._serialized`

### TDD Process
1. Write the 8 tests using plain object literals as fakes — they FAIL because `src/whatsapp.ts` doesn't exist (RED)
2. Implement the pure helpers (`formatMessageLine`, `formatRawMessage`, `getOwnerName`, `getOwnerId`) to pass the tests (GREEN)
3. Then implement the client-dependent functions (`createClient`, `waitForReady`, `fetchAllChats`, `fetchGroupChats`, `fetchMessages`) — these are not covered by automated tests in this task
4. Run `npm test` — confirm all green

### Mocking Discipline
- Mock only at the **system boundary**: paid/external APIs, network, wall clock & randomness, destructive side effects, filesystem I/O.
- Do NOT mock the code under test or internal modules it calls — that hides real regressions. Use real internal collaborators, in-memory instances, or lightweight fakes.
- Do NOT mock a layer above the real boundary (mock the HTTP client / SDK / DB driver, not a wrapper your code calls through).
- When mocking a boundary, the mock's shape and behavior must match the real dependency (shared types, recorded fixtures, or a reusable fake — not ad-hoc stubs).

> The WhatsApp network connection is the system boundary. Tests use plain objects shaped like `Message` and `Client` — not mocks of the `whatsapp-web.js` module — because we are testing our own mapping logic, not the library itself.
