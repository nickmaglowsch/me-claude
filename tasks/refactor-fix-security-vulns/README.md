# Security Fix Tasks — me-claude

Five tasks addressing 6 of 12 audit findings. Six findings were deferred by user decision after the discovery pass.

## Quick Reference

| Task | Finding(s) | Files Changed | Risk |
|------|-----------|--------------|------|
| [task-01](task-01-sandbox-cwd-and-input-fencing.md) | V-001 + V-004 | `src/sandbox.ts` (new), `src/index.ts`, `src/prompts.ts` | Medium — structural change to subprocess invocation |
| [task-02](task-02-slug-jid-hash.md) | V-009 | `src/groups.ts` | Low — only affects new group registrations |
| [task-03](task-03-filltemplate-safe-replace.md) | V-010 | `src/prompts.ts` | Low — one function, behavior-identical for all current keys |
| [task-04](task-04-topic-validation-and-schema.md) | V-011 | `src/commands.ts`, `src/ambient.ts` | Low — adds guards, no behavior change for valid input |
| [task-05](task-05-tmpfile-random-naming.md) | V-012 | `src/memory.ts`, `src/ambient.ts`, `src/memory-guard.ts`, `src/groups.ts`, `src/atomic.ts` (new) | Low — drop-in replacement for tmp name generation |

## Execution Order

1. **task-01** — apply first; it is the largest and touches the most files
2. **task-02, task-03, task-04, task-05** — can run in parallel after task-01, with two sequencing notes:
   - task-03 also edits `src/prompts.ts` — apply after task-01 is merged (different functions, no conflict, but easier to review sequentially)
   - task-04 and task-05 both edit `src/ambient.ts` — apply one before the other

## Skipped Findings

V-002 (memory-guard on runtime path), V-003 (path traversal in owner commands), V-005 (session dir relocation), V-006 (dependency pinning), V-007 (per-group rate limiter), V-008 (cross-contact Grep) — all deferred or accepted by user decision. See [refactor-plan.md](refactor-plan.md) for rationale.

## Test Command

```bash
npm test
```

All tasks require existing tests to remain green. Each task includes new tests; these should be added before or alongside the implementation (TDD ordering noted per task).
