# Implementation Notes

## Task 01: Project Scaffold
- **Decisions**: Created `vitest.config.ts` (not specified in task file) to restrict Vitest to `src/**/*.test.ts` only — became necessary after `npm run build` compiled test files to `dist/`, which Vitest then picked up and failed due to CJS/ESM incompatibility with Vitest's import mechanism.
- **Deviations**: Added `vitest.config.ts` (task did not mention it, but it was required for correct test behavior).
- **Trade-offs**: None significant — the config is minimal and correct.
- **Risks**: None.

## Task 02: Prompts Module
- **Decisions**: META_PROMPT and RUNTIME_PROMPT pasted verbatim from task file including all single-brace `{KEY}` placeholders. `fillTemplate` uses a per-key global regex loop — simple and correct.
- **Deviations**: None.
- **Trade-offs**: None.
- **Risks**: None.

## Task 03: Claude Subprocess Wrapper
- **Decisions**: Exported a mutable `_config` object (`{ command, args, timeoutMs }`) instead of separate `export let` variables. This was required because Vitest runs tests in a module context where exported `let` bindings are read-only (only a getter is exposed). The `_config` object's properties are mutable. Tests set `_config.command = 'node'` and `_config.args = [...]` to substitute the real `claude` binary without mocking `child_process`.
- **Deviations**: Task specified `export let _claudeCommand` pattern; switched to `export const _config = { command, args, timeoutMs }` due to the getter-only constraint in Vitest/ESM. Semantically equivalent.
- **Trade-offs**: Slightly different API for test overrides — callers set `_config.command` instead of `_claudeCommand`. The `_claudeArgs` field is an addition needed to inject node args in tests.
- **Risks**: None for runtime behavior — the config object is only for testing.

## Task 04: Message Extraction Module
- **Decisions**: All five functions are pure with no external dependencies. `filterMessages` uses `body.trim()` for both the length check and the `'<Media omitted>'` comparison per spec. `stratifiedSampleByChat` uses `slice(0, perChatMax)` which handles `perChatMax=0` and short arrays correctly.
- **Deviations**: None.
- **Trade-offs**: None.
- **Risks**: None.

## Task 05: WhatsApp Client Helpers
- **Decisions**: Tests use plain object literals typed as `any` for `Message` and `Client` fakes — no mocking of `whatsapp-web.js`. `formatMessageLine` uses local time (`getHours`/`getMinutes`) per spec. `getOwnerName` uses `||` to handle `null`, `undefined`, and empty string all as falsy.
- **Deviations**: None.
- **Trade-offs**: None.
- **Risks**: `whatsapp-web.js` type definitions may not perfectly match runtime shape — `skipLibCheck: true` in tsconfig mitigates compilation issues.

## Task 06: Setup Entry Point
- **Decisions**: Implemented verbatim from the task spec. `checkMinimumVolume` is allowed to throw and propagate to the `.catch()` handler for a clean exit code 1.
- **Deviations**: None.
- **Trade-offs**: No TDD — task explicitly excluded orchestration from TDD scope.
- **Risks**: Depends on real WhatsApp session for E2E validation.

## Task 07: Runtime Entry Point
- **Decisions**: Exported `isMentioned`, `isRateLimited`, `recordReply`, `sleep` as pure functions. The `main()` function is untested orchestration. Rate limit constant is `10_000` ms per spec (not 60s). Before-context fetches `limit: 11` then filters out the mention to yield up to 10. After-context fetches `limit: 20` then filters by `timestamp > msg.timestamp`.
- **Deviations**: None.
- **Trade-offs**: `msg` typed as `any` in the handler to avoid importing WhatsApp message type directly in the entry point.
- **Risks**: 8-second after-wait in the handler adds latency; this is intentional per spec.

## Task 08: README Documentation
- **Decisions**: All 8 required sections included in order. Paths `data/voice_profile.md` and `data/session/` used throughout. Rate limit (10s) and after-wait (8s) documented in runtime section.
- **Deviations**: None.
- **Trade-offs**: None.
- **Risks**: None.
