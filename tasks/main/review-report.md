# Code Review Report

## Summary

This greenfield WhatsApp voice-mimicking bot is **ready to ship**. All eight tasks are implemented per spec, the PRD's sharp edges (single-brace placeholders, 10-second rate limit, per-chat stratified sampling, verbatim prompt text) are correctly honored, the build exits 0, and 53/53 Vitest tests pass. I found no critical or important issues. A handful of very minor items are noted below for consideration in future iterations.

## PRD Compliance

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | TypeScript 5.x + Node 20, CommonJS (no `"type":"module"`), strict mode, ES2022 target | ✅ Complete | `tsconfig.json` exactly matches PRD. `package.json` has no `type: module`. |
| 2 | Scripts: `start`, `setup`, `build`, `test`, `test:watch` | ✅ Complete | `package.json:5-11` — all five scripts verbatim |
| 3 | Runtime deps: `whatsapp-web.js`, `qrcode-terminal` | ✅ Complete | `package.json:12-15` |
| 4 | Dev deps: `typescript`, `tsx`, `@types/node`, `vitest` | ✅ Complete | `package.json:16-21` |
| 5 | Directory layout (`src/`, `data/`, `data/session/`, `data/voice_profile.md`) | ✅ Complete | `data/.gitkeep` present; all `src/*.ts` files exist |
| 6 | `.gitignore` exactly: `node_modules/`, `dist/`, `data/session/`, `data/voice_profile.md`, `.env`, `*.log` | ✅ Complete | `.gitignore` byte-for-byte matches PRD |
| 7 | `META_PROMPT` text verbatim from PRD with `{MESSAGES_GO_HERE}` placeholder | ✅ Complete | Byte-for-byte match (verified via diff) |
| 8 | `RUNTIME_PROMPT` text verbatim with four single-brace placeholders | ✅ Complete | Byte-for-byte match (verified via diff) |
| 9 | `fillTemplate` uses single-brace `{KEY}` via global regex per key | ✅ Complete | `src/prompts.ts:113-119` |
| 10 | `callClaude` always pipes prompt via stdin (no `-p`, no args) | ✅ Complete | `src/claude.ts:17-18` |
| 11 | `callClaude` 60-second timeout → rejects with message containing `"timed out"` | ✅ Complete | `src/claude.ts:27-31` — `"claude CLI timed out after 60s"` |
| 12 | `callClaude` non-zero exit → rejects with code + stderr | ✅ Complete | `src/claude.ts:36-38` |
| 13 | `filterMessages`: `fromMe===true`, `type==='chat'`, `body.trim().length>=3`, body !== `<Media omitted>`; does NOT drop numeric-only | ✅ Complete | `src/extract.ts:9-16` — trim used, numeric retained (tested with body `'123'`) |
| 14 | `stratifiedSampleByChat(arrays, 50)` — up to 50 per chat, concatenated | ✅ Complete | `src/extract.ts:18-24` |
| 15 | `shuffle` = Fisher-Yates, returns new array, does not mutate | ✅ Complete | `src/extract.ts:26-33` — copies via spread first |
| 16 | `checkMinimumVolume(msgs)` throws `"Not enough message history to build a reliable voice profile."` when `length < 100` | ✅ Complete | `src/extract.ts:35-39` — exact string |
| 17 | `formatMessagesForPrompt` joins bodies with `"\n---\n"` | ✅ Complete | `src/extract.ts:41-44` |
| 18 | `createClient` uses `LocalAuth({ dataPath: 'data/session/' })`, wires `qr` + `auth_failure`, does NOT initialize | ✅ Complete | `src/whatsapp.ts:4-20` |
| 19 | `waitForReady(client)` 120s timeout | ✅ Complete | `src/whatsapp.ts:22-33` |
| 20 | `fetchAllChats` returns ALL chats (no filter) | ✅ Complete | `src/whatsapp.ts:35-37` |
| 21 | `fetchMessages(chat, 500)` default limit = 500 | ✅ Complete | `src/whatsapp.ts:44-46` |
| 22 | `formatMessageLine` → `[HH:MM] SenderName: body`, zero-padded, local time | ✅ Complete | `src/whatsapp.ts:48-53` |
| 23 | `formatRawMessage` maps all 5 fields (`fromMe`, `type`, `body`, `author??undefined`, `timestamp`) | ✅ Complete | `src/whatsapp.ts:55-63` |
| 24 | `getOwnerName` → `pushname \|\| "Owner"` | ✅ Complete | `src/whatsapp.ts:65-67` |
| 25 | `getOwnerId` → `client.info.wid._serialized` | ✅ Complete | `src/whatsapp.ts:69-71` |
| 26 | Setup iterates ALL chats (groups + DMs), fetches up to 500 per chat | ✅ Complete | `src/setup.ts:38-50` uses `fetchAllChats` + `fetchMessages(chat, 500)` |
| 27 | Setup does per-chat stratified sampling (50 per chat), then shuffle, then volume check | ✅ Complete | `src/setup.ts:54-64` — note: volume check runs at line 58 AFTER sampling per PRD step 10 |
| 28 | Setup fills `MESSAGES_GO_HERE` single-brace | ✅ Complete | `src/setup.ts:67-69` |
| 29 | Setup writes `data/voice_profile.md`, creates `data/` if missing | ✅ Complete | `src/setup.ts:75-78` — `mkdirSync({ recursive: true })` |
| 30 | Setup logs `Bot online as <ownerName> (<ownerId>)` | ✅ Complete | `src/setup.ts:35` |
| 31 | Setup logs `Voice profile written to data/voice_profile.md. Review it before going live.` | ✅ Complete | `src/setup.ts:79` — exact string |
| 32 | Setup exits 0 on success, 1 on error (via `.catch`) | ✅ Complete | `src/setup.ts:82,85-88` |
| 33 | Runtime `message_create` gates: `isGroup` + `!fromMe` + `mentionedIds.includes(ownerId)` | ✅ Complete | `src/index.ts:74-81` |
| 34 | Runtime rate limit is **10 seconds** per group (10,000 ms) | ✅ Complete | `src/index.ts:15` `RATE_LIMIT_MS = 10_000` |
| 35 | Runtime before-context: `chat.fetchMessages({ limit: 11 })`, exclude mention, slice to 10 | ✅ Complete | `src/index.ts:90-93` |
| 36 | Runtime sleeps 8 seconds before fetching after-messages | ✅ Complete | `src/index.ts:96` — `AFTER_WAIT_MS = 8_000` |
| 37 | After-context: filter `timestamp > msg.timestamp`, take up to 10 | ✅ Complete | `src/index.ts:99-102` (code adds a redundant `id !== msg.id` guard — harmless) |
| 38 | Empty Claude response → silent skip (no `msg.reply('')`) | ✅ Complete | `src/index.ts:132` |
| 39 | Uses `msg.reply(reply)` not `chat.sendMessage` | ✅ Complete | `src/index.ts:134` |
| 40 | Runtime log `[<group name>] <sender>: <body> -> <reply>` | ✅ Complete | `src/index.ts:137` — exact format |
| 41 | Missing `data/voice_profile.md` → helpful error + exit 1 | ✅ Complete | `src/index.ts:62-66` |
| 42 | `OWNER_ID` env var overrides auto-detected ID; both logged | ✅ Complete | `src/setup.ts:30-32`, `src/index.ts:54-56` |
| 43 | `BEFORE_MESSAGES` fallback: literal `(no messages before)` | ✅ Complete | `src/index.ts:123` |
| 44 | `AFTER_MESSAGES` fallback: literal `(no messages after yet)` | ✅ Complete | `src/index.ts:125` |
| 45 | README: prereqs, install, setup, runtime, config, architecture, development | ✅ Complete | All 8 sections present, paths correct, 10s/8s timings documented |

**Compliance Score**: 45/45 requirements fully met

## Issues Found

### Critical (must fix before shipping)
- None

### Important (should fix)
- None

### Minor (nice to fix)
- **`src/index.ts:55`, `src/setup.ts:31`**: `process.env.OWNER_ID ?? detectedId` treats an empty-string env var as "set" and will pass it through. If someone exports `OWNER_ID=""`, the bot will try to match against empty JID. Using `||` instead of `??` would fall back to detection for empty strings. The PRD doesn't specify either behavior, so this is defensible, but `||` is marginally safer against shell misuse.
- **`src/index.ts:101`**: The after-fetch adds a redundant `m.id._serialized !== msg.id._serialized` filter that isn't in the task spec (which only requires `timestamp > msg.timestamp`). Harmless defensive code, but drifts from the spec's stated logic by one filter condition. Note in `implementation-notes.md` would help traceability.
- **`src/index.ts:89-93`**: Before-context fetches 11 messages and filters by id; if other messages arrived in the tiny window between the `message_create` firing and the fetch, the mention may not be in those 11, and `slice(-10)` could include messages that arrived AFTER the mention. This matches the PRD logic literally, so it's not a violation — but it's a subtle edge case worth being aware of.
- **`src/whatsapp.ts:10-12`**: `require('qrcode-terminal')` is called inside the `qr` handler every time a QR event fires, rather than being cached to a module-level constant. Spec says "Use `require('qrcode-terminal')` at call time (avoids TypeScript type issues)" so this is explicitly intended — flagging only for visibility.
- **`src/index.test.ts:55-60`**: The `sleep` test only asserts `elapsed >= 40` for a 50ms sleep; it has no upper bound, so a hung `setTimeout` replacement would still pass. A weak-but-spec-compliant test (the task file explicitly says ">= 40ms"). Not worth changing.
- **`tasks/main/implementation-notes.md:16`**: The task-03 notes say the task "specified `export let _claudeCommand` pattern" but the actual implementation uses `export const _config = { ... }`. The notes explain the Vitest ESM getter-only rationale clearly; good documentation. No issue — flagging as a positive.

## What Looks Good

- **Prompt text is byte-for-byte identical to PRD.** I diffed `META_PROMPT` and `RUNTIME_PROMPT` in `src/prompts.ts` against the code blocks in `tasks/main/updated-prd.md` and both match exactly, including em-dashes (`—`) and single-brace placeholders. This is the single biggest correctness win.
- **Placeholder naming is correct.** All five placeholders are single-brace uppercase (`{MESSAGES_GO_HERE}`, `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}`). No double-brace leakage anywhere in `src/`.
- **Rate limit is 10 seconds** (`RATE_LIMIT_MS = 10_000`) — the planner's previously-corrected 60s error did not resurface.
- **Per-chat stratified sampling with `perChatMax=50`** is the only sampling function implemented; no by-month code path exists. The `slice(0, perChatMax)` cleanly handles `perChatMax=0` and short arrays.
- **Path discipline is tight.** All reads/writes go through `data/voice_profile.md` and `data/session/`. No root-level `voice_profile.md` or `.wwebjs_auth/` anywhere in the code.
- **Gitignore is exactly the 6 entries** the PRD specifies, in the right order.
- **Claude wrapper uses stdin unconditionally** (`src/claude.ts:17-18`) — no `-p` flag path, no arg-size threshold.
- **Test framework isolation is correct.** The `vitest.config.ts` scoping to `src/**/*.test.ts` is a necessary addition (documented in implementation-notes) that prevents compiled `dist/` test files from being re-run as CJS. Good call to add it.
- **The `_config` object pattern in `claude.ts`** is a clean workaround for Vitest's getter-only handling of `export let`, and the implementer documented the reasoning. Tests use real `node -e` subprocesses as the boundary substitute — exactly what the Mocking Discipline section asks for.
- **Runtime handler has proper error handling**: the whole `message_create` body is wrapped in `try/catch` so an error handling one mention doesn't crash the long-running process.
- **Empty-reply silence is respected** (`src/index.ts:132`) — the bot does not send empty messages.
- **TypeScript is strict** and the build exits 0 with no warnings.

## Test Coverage

| Area | Tests Exist | Coverage Notes |
|------|-------------|----------------|
| `prompts.ts` / `fillTemplate` | Yes | 7 tests: single/multiple/repeated/missing/empty/META smoke/RUNTIME smoke. Solid. |
| `claude.ts` / `callClaude` | Yes | 3 tests using real Node subprocesses: success, non-zero exit, timeout. Good boundary substitution. |
| `extract.ts` (filter/sample/shuffle/checkMinVolume/format) | Yes | 22 tests — covers fromMe/type/length/media-placeholder/numeric-keep, per-chat caps, shuffle non-mutation, volume boundary at 99/100, format joining. Thorough. |
| `whatsapp.ts` pure helpers | Yes | 12 tests: `formatMessageLine`, `formatRawMessage`, `getOwnerName`, `getOwnerId`. Non-pure helpers (`createClient`, `waitForReady`, `fetchAllChats`, `fetchGroupChats`, `fetchMessages`) not tested — per TDD scope. |
| `index.ts` pure helpers | Yes | 9 tests: `isMentioned` (3), `isRateLimited` (3), `recordReply` (2), `sleep` (1). |
| `setup.ts` main() orchestration | No (by design) | TDD explicitly excluded per task 06 spec — orchestration only. |
| `index.ts` `message_create` handler | No (by design) | TDD explicitly excluded per task 07 spec — orchestration using tested primitives. |

**Test Coverage Assessment**: Coverage is appropriate for the scope. The pure-logic modules (`prompts`, `claude`, `extract`, `whatsapp` formatters, `index` helpers) have 53 tests that exercise the acceptance criteria, boundary conditions (99/100 volume check, 3-char body threshold, `perChatMax=0`), and error paths (timeout, non-zero exit). Orchestration entry points are untested — this is explicitly permitted by the TDD scope in the PRD and task files, and all primitives they compose are tested.

## Test Execution

| Check | Result | Details |
|-------|--------|---------|
| Test command discovered | Yes (`npm test` → `vitest run`) | Found in `package.json` scripts and confirmed in shared-context + task TDD sections |
| Test suite run | Passed (53/53) | 5 test files, 289ms total duration, 0 failures |
| Build | Passed | `npm run build` (`tsc`) exits 0 with no output |
| TDD evidence in implementation notes | Yes | `implementation-notes.md` describes decisions per task; explicit runtime behavior choices (timeout values, slice logic, empty-reply handling) are documented |

**Test Execution Assessment**: Tests run cleanly and quickly. Vitest output is tidy (`Test Files 5 passed (5) / Tests 53 passed (53)`). No flakiness observed. Build compiles without warnings under strict TypeScript. The test suite is structured so a regression in any exported pure helper would fail fast.

## TDD Compliance

| Task | Tests Written | Tests Adequate | TDD Skipped Reason Valid | Notes |
|------|---------------|---------------|-------------------------|-------|
| Task 02 (prompts) | Yes (7) | Yes | N/A | All 7 specified tests present. `fillTemplate` tests cover single/multi/repeat/missing/empty + META/RUNTIME smoke tests. Assertions use concrete `toBe`/`not.toContain`/regex — specific enough to catch real regressions. |
| Task 03 (claude) | Yes (3) | Yes | N/A | All 3 specified tests present. Uses real `node -e` subprocesses as boundary substitutes — exactly the mocking discipline the task specifies. Tests echo input via stdin, assert on rejection message content, and exercise real timer behavior. Would catch regressions in arg threading, exit code handling, and timeout. |
| Task 04 (extract) | Yes (22) | Yes | N/A | All 16+ specified tests present; implementer added more (e.g., numeric-only keep, empty-array path for each function). Assertions are value-specific (`toHaveLength`, `toBe`, `toEqual`). `shuffle` test correctly uses sorted comparison instead of asserting a specific permutation. |
| Task 05 (whatsapp) | Yes (12) | Yes | N/A | All 8 specified tests present + extras. Uses plain objects typed as `any` — no mocking of `whatsapp-web.js` module. `formatMessageLine` tests derive expected HH:MM from a real `Date` to stay TZ-independent — clean. `getOwnerName` tests both `null` and `""` falsy branches. |
| Task 07 (runtime) | Yes (9) | Yes (with one weak assertion) | N/A | All 9 specified tests present. `isMentioned`, `isRateLimited`, `recordReply` tests use concrete assertions on return values and Map state. `sleep` test has only a lower-bound assertion (`>= 40ms`) — this matches the task spec exactly, but is slightly loose. Orchestration (handler, main) is correctly not tested per TDD scope. |
| Task 01 (scaffold) | N/A | N/A | Yes | Infrastructure — no logic to test. |
| Task 06 (setup) | None (by design) | N/A | Yes | Task file explicitly excludes TDD: "integration-level orchestration with no pure logic of its own. All pure helpers it calls are tested in 02/03/04/05." Reasoning is valid — every helper `setup.ts` invokes is covered by other tests. |
| Task 08 (README) | N/A | N/A | Yes | Documentation — no logic to test. |

**TDD Assessment**: TDD was executed correctly on all 5 tasks where it was specified. No task declared "TDD not feasible" spuriously; the two explicit skips (tasks 06 and 08) are justified (orchestration composed entirely of tested primitives, and documentation). No internal modules are mocked — the test boundary is set at the real system edge (Claude CLI → substituted `node`; WhatsApp Message/Client → plain object fakes). Implementation-notes evidence: task 07 explicitly notes "Rate limit constant is 10_000 ms per spec (not 60s). Before-context fetches limit:11 then filters... After-context fetches limit:20 then filters by timestamp > msg.timestamp" — demonstrates the implementer verified runtime behavior against the spec.

**Test Adequacy**: 53/53 tests are meaningful and specific. One test flagged as weak (listed as Minor above): `src/index.test.ts:55-60` `sleep` has only a lower-bound assertion — matches task spec, but wouldn't catch a "never resolves" regression. All other assertions would catch real regressions. No trivially-true assertions (`expect(true).toBe(true)`) or "merely defined" assertions. No mocking of code-under-test or internal modules.

## Implementation Decision Review

| Task | Decisions Documented | Decisions Sound | Flags |
|------|---------------------|----------------|-------|
| Task 01 | Yes | Yes | Adding `vitest.config.ts` to scope tests to `src/` is correct and necessary — documented with reasoning (compiled test files in `dist/` otherwise get re-picked-up and fail due to CJS/ESM conflict). |
| Task 02 | Yes | Yes | Verbatim paste, no deviations. Confirmed via byte-diff. |
| Task 03 | Yes | Yes | The `_config` object instead of `export let _claudeCommand` is a principled workaround for Vitest's getter-only handling of `let` exports. Semantically equivalent to what the task required and the test API it enables (`_config.command = 'node'; _config.args = [...]`) is cleaner than what the original spec would have given. |
| Task 04 | Yes | Yes | All pure; `body.trim()` used per spec for both length check and media-placeholder comparison. |
| Task 05 | Yes | Yes | Plain-object fakes in tests; `\|\|` operator in `getOwnerName` to unify `null`/`undefined`/empty-string falsy handling. |
| Task 06 | Yes | Yes | Verbatim from spec; `checkMinimumVolume` throws propagate to `.catch` for clean exit 1. |
| Task 07 | Yes | Yes | Constants (`RATE_LIMIT_MS=10_000`, `AFTER_WAIT_MS=8_000`) match spec. `any` typing for the handler's `msg` param is defensible given library type drift. |
| Task 08 | Yes | Yes | All 8 required sections; paths use `data/voice_profile.md` and `data/session/`. |

**Decision Assessment**: The implementer made consistently sound calls. The two non-obvious decisions (adding `vitest.config.ts` and switching from `export let _claudeCommand` to `export const _config`) are both documented with clear rationale and are materially better than the naive spec approach would have been. No decisions stand out as wrong despite the documented reasoning.

## Recommendations

1. **Ship it.** All PRD requirements met; no critical or important issues found.
2. (Optional, low priority) Consider `||` over `??` for `process.env.OWNER_ID` resolution so an empty-string override doesn't silently bypass auto-detection. Two-line change in `src/index.ts` and `src/setup.ts`.
3. (Optional, low priority) The redundant `id !== msg.id` guard in the after-context filter (`src/index.ts:101`) could be removed to match the task spec's stated logic exactly, or documented as a deliberate belt-and-suspenders defense.
4. (Future) Once you run `npm run setup` against a real WhatsApp session, capture the actual log output (owner name/ID line, chat count, sampled count) and add a short "smoke-verified on: <date>" note to `implementation-notes.md`. This is the only piece of end-to-end verification currently outstanding.
