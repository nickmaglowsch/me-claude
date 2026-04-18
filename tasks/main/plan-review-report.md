# Plan Review Report

## Summary
The plan is internally consistent, covers the PRD comprehensively, and has a clean dependency DAG with no cycles or phantom references. The corrections from the planner cycle (single-brace placeholders, before/wait/after context window, 10-second rate limit, per-chat stratification) are all applied uniformly across task files, shared context, and PRD. One Minor correctness concern exists around the `beforeMessages` slice direction in task-07, and the runtime `.ts` files are missing explicit dependencies on `extract.ts` (task-04) where they use `RawMessage`-adjacent types, though in practice this is transitively satisfied.

## Plan Review

### Dependency Graph

| Task | Depends On | Status |
|------|-----------|--------|
| task-01 | None | ✅ Valid (root) |
| task-02 | 1 | ✅ Valid |
| task-03 | 1 | ✅ Valid |
| task-04 | 1 | ✅ Valid |
| task-05 | 1, 4 | ✅ Valid — imports `RawMessage` from extract.ts |
| task-06 | 2, 3, 4, 5 | ✅ Valid (task-01 transitively covered via 2/3/4/5) |
| task-07 | 2, 3, 5 | ✅ Valid (task-01 transitively covered; task-04 not directly needed since runtime doesn't import from extract) |
| task-08 | 1 | ✅ Valid |

No circular dependencies. No phantom references — all numeric deps resolve to existing files. Topological order: 1 → {2, 3, 4, 8} → 5 → {6, 7}.

**Dependency Assessment**: No issues found. Task-06 and task-07 technically omit a direct `1` dep, but it is transitively satisfied via their explicit deps on tasks 2–5 (which all depend on 1). This is conventional for DAG notation and acceptable.

### PRD Coverage

| PRD Requirement | Covered By | Status |
|----------------|-----------|--------|
| `package.json` with all 5 scripts (`start`, `setup`, `build`, `test`, `test:watch`) | task-01 | ✅ Covered |
| Runtime deps: `whatsapp-web.js`, `qrcode-terminal` | task-01 | ✅ Covered |
| Dev deps: `typescript`, `tsx`, `@types/node`, `vitest` | task-01 | ✅ Covered |
| `tsconfig.json` with exact compiler options (ES2022/CJS/strict/etc.) | task-01 | ✅ Covered |
| `.gitignore` with 6 exact entries | task-01 | ✅ Covered |
| `src/` and `data/` directories | task-01 | ✅ Covered |
| Directory layout (src/, data/, session/, voice_profile.md) | task-01 + task-06 + task-07 | ✅ Covered |
| `META_PROMPT` verbatim text with `{MESSAGES_GO_HERE}` | task-02 | ✅ Covered (full verbatim text embedded) |
| `RUNTIME_PROMPT` verbatim text with 4 placeholders | task-02 | ✅ Covered (full verbatim text embedded) |
| `fillTemplate()` single-brace uppercase, global replace | task-02 | ✅ Covered |
| `callClaude()`: spawn, stdin always, 60s timeout, non-zero reject | task-03 | ✅ Covered |
| `RawMessage` interface (with `type` field) | task-04 | ✅ Covered |
| `filterMessages()` — fromMe, type='chat', len>=3, not `<Media omitted>`, does NOT drop numeric | task-04 | ✅ Covered |
| `stratifiedSampleByChat(perChatMessages, perChatMax=50)` | task-04 | ✅ Covered |
| `shuffle()` Fisher-Yates, non-mutating | task-04 | ✅ Covered |
| `checkMinimumVolume()` throws at <100 with exact message | task-04 | ✅ Covered |
| `formatMessagesForPrompt()` joined with `\n---\n` | task-04 | ✅ Covered |
| `createClient()` with `LocalAuth({ dataPath: 'data/session/' })` | task-05 | ✅ Covered |
| `waitForReady()` with 120s timeout | task-05 | ✅ Covered |
| `fetchAllChats()` returns ALL chats (no filter) | task-05 | ✅ Covered |
| `fetchGroupChats()` filters `isGroup` | task-05 | ✅ Covered |
| `fetchMessages(chat, limit=500)` | task-05 | ✅ Covered |
| `formatMessageLine()` — `[HH:MM] SenderName: body`, zero-padded, local time | task-05 | ✅ Covered |
| `formatRawMessage()` maps 5 fields including `type` | task-05 | ✅ Covered |
| `getOwnerName()` with `"Owner"` fallback | task-05 | ✅ Covered |
| `getOwnerId()` returns `wid._serialized` | task-05 | ✅ Covered |
| Setup flow (16 steps): init → ready → fetchAllChats → perChatMessages → filter → stratify → volumeCheck → shuffle → format → fillTemplate → callClaude → writeFile → destroy → exit(0) | task-06 | ✅ Covered |
| Setup output path: `data/voice_profile.md` with `mkdirSync recursive` | task-06 | ✅ Covered |
| Setup success log (verbatim) | task-06 | ✅ Covered |
| Runtime startup: init → ready → ownerId resolution → load voice_profile.md or exit 1 → register handler | task-07 | ✅ Covered |
| `message_create` gates: isGroup, !fromMe, mentionedIds.includes(ownerId) | task-07 | ✅ Covered |
| Rate limit: 10_000 ms per group (keyed by `chat.id._serialized`) | task-07 | ✅ Covered |
| Before-context: `fetchMessages({ limit: 11 })`, exclude mention, up to 10 | task-07 | ✅ Covered (see Minor issue on slice direction) |
| 8-second `sleep(AFTER_WAIT_MS)` wait | task-07 | ✅ Covered |
| After-context: `fetchMessages({ limit: 20 })`, `timestamp > msg.timestamp`, up to 10 | task-07 | ✅ Covered |
| Prompt filled with all 4 vars, empty fallbacks `(no messages before)` / `(no messages after yet)` | task-07 | ✅ Covered |
| Empty Claude response → silent skip (no `msg.reply`) | task-07 | ✅ Covered |
| Reply via `msg.reply()` (not `chat.sendMessage`) | task-07 | ✅ Covered |
| Runtime log format `[<group name>] <sender>: <mention body> -> <reply body>` | task-07 | ✅ Covered |
| Runtime startup log `Bot online as <ownerName> (<ownerId>)` | task-06, task-07 | ✅ Covered |
| `OWNER_ID` env override with `"Auto-detected owner ID: <x>. Using: <y>."` log | task-06, task-07 | ✅ Covered |
| README sections 1–8 (title, prereqs, install, setup, runtime, config, architecture, development) | task-08 | ✅ Covered |
| Voice profile at `data/voice_profile.md` (gitignored) | task-01 (.gitignore), task-06 (write), task-07 (read) | ✅ Covered |
| Session at `data/session/` | task-05 (LocalAuth), task-01 (.gitignore) | ✅ Covered |
| Vitest test infrastructure (`npm test`, watch mode, co-located `.test.ts`) | task-01 (scripts) + 02/03/04/05/07 (tests) | ✅ Covered |

**Coverage Score**: 40/40 PRD requirements covered. No scope creep detected — every task maps cleanly to one or more PRD sections.

### File Conflict Analysis

| File | Tasks Touching It | Conflict? |
|------|------------------|-----------|
| `package.json` | task-01 | ✅ Single owner |
| `tsconfig.json` | task-01 | ✅ Single owner |
| `.gitignore` | task-01 | ✅ Single owner |
| `src/prompts.ts` + `src/prompts.test.ts` | task-02 | ✅ Single owner |
| `src/claude.ts` + `src/claude.test.ts` | task-03 | ✅ Single owner |
| `src/extract.ts` + `src/extract.test.ts` | task-04 | ✅ Single owner |
| `src/whatsapp.ts` + `src/whatsapp.test.ts` | task-05 | ✅ Single owner |
| `src/setup.ts` | task-06 | ✅ Single owner |
| `src/index.ts` + `src/index.test.ts` | task-07 | ✅ Single owner |
| `README.md` | task-08 | ✅ Single owner |
| `data/voice_profile.md` (runtime artifact) | task-06 writes, task-07 reads | ✅ Read/write at different stages (setup vs runtime) — no conflict |
| `data/session/` (runtime artifact) | task-05 configures, task-01 gitignores | ✅ Config vs. ignore — no conflict |

**Conflict Assessment**: No conflicts detected. Each source file has a single writer task. Cross-task references (e.g., task-05 imports `RawMessage` from task-04's output, task-06/07 import from tasks 02/03/04/05) are resolved correctly via the dependency graph.

### Task Sizing

| Task | Assessment | Notes |
|------|-----------|-------|
| task-01 (scaffold) | ✅ Well-sized | 3 config files + 2 dirs; trivial but grouped logically. Not "too small" given it gates everything else. |
| task-02 (prompts) | ✅ Well-sized | One module with 3 exports; verbatim prompt text is long but unavoidable. 7 tests. |
| task-03 (claude) | ✅ Well-sized | Single focused subprocess wrapper; 3 tests covering happy path, error, timeout. |
| task-04 (extract) | ✅ Well-sized | 5 pure functions in one cohesive module; 16 tests. Arguably at the upper end, but all functions are small and the module is a single semantic concern (message processing). |
| task-05 (whatsapp) | ✅ Well-sized | 9 exports in one module, but they're all WA client helpers — a single semantic concern. Only pure helpers are tested (8 tests). |
| task-06 (setup) | ✅ Well-sized | Integration/orchestration of 4 modules in a 16-step flow. No tests (explicitly declared N/A). |
| task-07 (runtime) | ✅ Well-sized | Long-running listener with 4 exported pure helpers (9 tests) plus untested orchestration. Largest task file, but the orchestration is inherently where most behavior lives — splitting the pure helpers out into a separate task would create artificial coupling. |
| task-08 (README) | ✅ Well-sized | 8 sections of docs; pure deliverable. |

No task is oversized (none risks partial completion or touches 5+ unrelated files). No task is trivially small — even task-01 bundles the minimum required scaffolding atoms. Task sizing is consistent with a greenfield build where each file is owned by exactly one task.

### TDD Spec Consistency

| Task | Has TDD Section | Framework Valid | Command Valid | Status |
|------|----------------|-----------------|--------------|--------|
| task-01 | No (scaffold) | N/A | N/A | ✅ Correctly declared N/A |
| task-02 | Yes | Vitest ✅ | `npm test` ✅ | ✅ |
| task-03 | Yes | Vitest ✅ | `npm test` ✅ | ✅ |
| task-04 | Yes | Vitest ✅ | `npm test` ✅ | ✅ |
| task-05 | Yes (helpers only) | Vitest ✅ | `npm test` ✅ | ✅ |
| task-06 | Not applicable (orchestration) | N/A | N/A | ✅ Correctly declared N/A with reasoning |
| task-07 | Yes (pure helpers) | Vitest ✅ | `npm test` ✅ | ✅ |
| task-08 | Not applicable (docs) | N/A | N/A | ✅ Correctly declared N/A |

- Test framework (Vitest) is present in task-01 dev dependencies and in the `scripts.test` definition — the chain is consistent.
- `npm test` is defined in task-01's scripts block, so the test command is real and discoverable.
- Test file convention (`src/**/*.test.ts` co-located with source) is consistent across all tasks and matches shared-context.md.
- Mocking discipline section is identical across the TDD-enabled tasks (02, 03, 04, 05, 07) and correctly identifies the system boundary for each task.
- The PRD explicitly calls out that TDD does NOT apply to scaffolding, `setup.ts`, or `index.ts`/`setup.ts` orchestration — tasks 01, 06, and 08 correctly reflect this. Task-07 correctly applies TDD only to the pure exported helpers (`isMentioned`, `isRateLimited`, `recordReply`, `sleep`), not to `main()` or the `message_create` handler.

**TDD Spec Assessment**: All TDD specs are internally consistent, reference a real framework and real command, and correctly scope TDD to pure functions while declaring orchestration out-of-scope.

### Plan Issues Found

#### Critical (blocks implementation)
- None

#### Important (should fix before proceeding)
- None

#### Minor (nice to fix)
- **task-07-runtime.md (line 120)**: `beforeMessages = beforeFetch.filter(...).slice(-10)` — `whatsapp-web.js`'s `chat.fetchMessages({ limit: N })` returns messages in chronological order (oldest→newest of the last N). Filtering out the mention itself leaves up to 10 messages; taking `.slice(-10)` is correct (keeps the most recent up to 10), but the comment `// up to 10, most recent` is slightly misleading if the array is already ≤10 after filtering. No behavioral bug — the slice is a no-op when the array has ≤10 items. Consider adjusting the comment or using `.slice(0, 10)` for clarity; either works correctly. Non-blocking.
- **task-07-runtime.md (line 25)**: The imports list omits `fetchGroupChats` from `./whatsapp` even though `fetchGroupChats` is declared in task-05 as "Used by runtime (context window fetching) if needed". The runtime handler uses the `chat` object from `msg.getChat()` directly and never calls `fetchGroupChats`, so the import omission is correct — but this raises a dead-code question for `fetchGroupChats`. It is declared in the PRD (line 344) and task-05 but used by no task. Flag for removal if truly unused, or leave as API surface for future use. Non-blocking.
- **Shared-context.md and task-01 script list**: `package.json` in task-01 defines `build`, but no task explicitly calls `npm run build` as an acceptance check beyond compiling cleanly. Each task's "TypeScript compiles cleanly" criterion implicitly requires `npm run build` to succeed; this is fine, just worth noting that no task has an explicit integration `tsc --noEmit` step. Non-blocking.
- **task-06-setup.md "Blocks: None (leaf task)" and task-07-runtime.md "Blocks: None (leaf task)"**: task-06 and task-07 both claim to be leaf tasks, which is correct for the implementation DAG. However, task-08 (README) semantically documents behavior defined in tasks 06 and 07 (the 8-second wait, 10-second rate limit, `data/voice_profile.md` generation). task-08 declares "Depends on: Task 01" only. In practice the README content is already fully specified in task-08 itself (no re-derivation from task-06/07 is needed), so this is not a real dependency gap — just worth confirming the README text doesn't drift if task-06/07 specs evolve. Non-blocking.

## What Looks Good
- **Placeholder discipline**: every reference to `{MESSAGES_GO_HERE}`, `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}` uses single-brace uppercase consistently across task-02 (verbatim constants, tests, acceptance criteria), task-06 (setup call site), task-07 (runtime call site), shared-context, and the PRD. The correction cycle clearly took hold.
- **Verbatim prompt text**: task-02 embeds the full META_PROMPT and RUNTIME_PROMPT literally so the implementer cannot paraphrase or misquote. Both prompts match the PRD text exactly.
- **Rate limit (10s) and context window (8s wait, 10+10 messages)**: consistent across task-07, shared-context, PRD, task-08 (README doc), and the README summary file. No drift.
- **Per-chat stratification**: `stratifiedSampleByChat(perChatMessages, 50)` is consistent across task-04 (definition + tests), task-06 (call site), PRD, and shared-context. `perChatMessages` is built correctly as array-of-arrays in task-06 step 8.
- **System boundary clarity**: every TDD-enabled task's mocking discipline section correctly identifies the boundary (claude CLI for task-03, WA network for task-05, real timers for task-07's sleep test, pure data for tasks 02/04). No task recommends mocking internal collaborators.
- **PRD completeness**: 100% of resolved PRD requirements have a clear implementing task. No orphaned requirements, no orphaned tasks.
- **Dependency DAG is clean**: linear fan-out from task-01 to {02,03,04,05,08}, then convergence through task-05 (depends on 04) and tasks 06/07 (depend on the module tasks). No cycles, no phantom refs, no unordered concurrent writes.
- **File ownership**: every source file has a single writing task. `data/voice_profile.md` is the only cross-task artifact and its read/write timing (setup writes, runtime reads) is ordered at the operational level, not the build level.

## Recommendations
1. Proceed to implementation. The plan is ready to execute.
2. Tasks can be dispatched as: task-01 first (blocker), then tasks 02/03/04/08 in parallel, then task-05 (after 04), then tasks 06/07 in parallel (after their respective deps).
3. Consider removing or documenting `fetchGroupChats` in task-05 if no runtime task currently uses it (Minor — not a blocker).
4. Optionally clarify the `.slice(-10)` comment in task-07 step for before-context (Minor — the code is correct, the comment is just slightly imprecise).
