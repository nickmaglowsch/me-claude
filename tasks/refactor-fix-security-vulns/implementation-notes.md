# Implementation Notes

## Task 01: Sandbox cwd + Input Fencing (V-001 + V-004)
- **Decisions**: Sandbox cleanup runs in `.catch()` inside the `finally` block so cleanup failure is logged but doesn't mask the original error. `sanitizePushname` strips only `\r\n`, backticks, and leading `#`; emoji/unicode pass through.
- **Deviations**: None from task spec.
- **Trade-offs**: Sandbox uses symlinks (not copies) so Claude writes persist and cross-contact Grep (V-008 intentionally kept) still works.
- **Risks**: Sandbox dirs in OS tmp may leak on SIGKILL; acceptable — OS tmp cleanup or a startup sweep handles it.

## Task 02: Append JID Hash to Group Slug (V-009)
- **Decisions**: Used `node:` import prefix. Replaced the old collision-counter tests with equivalent tests that pre-populate the index to force a baseSlug clash (since two distinct JIDs with the same name no longer collide after hashing).
- **Deviations**: None.
- **Trade-offs**: The counter fallback is now a pure last-resort against SHA-256 prefix collisions (~1 in 16M); practical collisions are structurally prevented.
- **Risks**: Downstream callers that hardcoded `'mgz'` etc. would break — audit found none in production code; only tests needed updating.

## Task 03: Safe String Replace in fillTemplate (V-010)
- **Decisions**: Removed the `safeValue` `$`-escaping line entirely — with `split/join` the replacement is always literal.
- **Deviations**: None.
- **Trade-offs**: Chose `split/join` over an `escapeRegExp` helper — simpler, no moving parts, cannot silently misbehave.
- **Risks**: None — all production keys are hardcoded UPPER_SNAKE_CASE.

## Task 04: Topic Validation + Ambient Config Schema Guard (V-011)
- **Decisions**: `isValidAmbientConfig` is internal (not exported). Added `vi` to `ambient.test.ts` imports.
- **Deviations**: None.
- **Trade-offs**: Hand-rolled guard keeps the project dep-free (no zod). A field added to `AmbientConfig` in the future must also be added to the guard, otherwise new configs fail validation.
- **Risks**: `defaultAmbientConfig()` includes today's date in `lastReset`; tests comparing with `toEqual(defaultAmbientConfig())` would theoretically fail at midnight rollover.

## Task 05: Unpredictable Tmp File Names for Atomic Writes (V-012)
- **Decisions**: Extracted `src/atomic.ts` helper rather than repeating the crypto + O_EXCL pattern four times. `O_NOFOLLOW` uses `?? 0` fallback for platforms without the constant. `CONTACTS_DIR` is module-level (computed from `process.cwd()` at import); test adapted to import it directly instead of faking cwd.
- **Deviations**: Added a concurrent test for `saveGroupIndex` for symmetry even though the task template didn't include it.
- **Trade-offs**: None.
- **Risks**: None — all four migrated sites preserve existing semantics.
