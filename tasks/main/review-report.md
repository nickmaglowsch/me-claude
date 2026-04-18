# Code Review Report

## Summary

The batch implements all four planned improvements (items 1, 2, 4, 5) with good test coverage, a clean event schema, and a correctly-scoped self-chat command gate. The build is green, 134/134 tests pass, and the new modules (`events.ts`, `memory-guard.ts`, `commands.ts`, `stats.ts`) are well-factored.

Not shippable as-is. There are two **Critical** issues — a shell-injection surface in `gitCommit` via `execSync` with interpolated strings, and `!remember` falsely confirming success even when the corruption guard rejects the write — plus a handful of **Important** bugs (duplicated `command.received` events, divergent silence key semantics, help-text containing `!` that weakens the defense-in-depth recursion guard).

---

## PRD Compliance

### Task 01 — Memory Guard

| # | Requirement | Status | Notes |
|---|---|---|---|
| 01.1 | `guardedWriteContactMemory` + `writeContactMemoryGuarded` exported | ✅ Complete | `src/memory-guard.ts:96,166`, re-exported from `src/memory.ts:52` |
| 01.2 | Empty/whitespace rejection | ✅ Complete | `src/memory-guard.ts:102-105` |
| 01.3 | >8KB rejection | ✅ Complete | `src/memory-guard.ts:108-113` |
| 01.4 | Shrinkage >30% on old>200 chars | ✅ Complete | `src/memory-guard.ts:124-132` |
| 01.5 | Missing `## Identity` header rejection | ✅ Complete | `src/memory-guard.ts:135-145` |
| 01.6 | Atomic tmp+rename write | ✅ Complete | `src/memory-guard.ts:40-47` |
| 01.7 | `git add -f` used to bypass gitignore | ✅ Complete | `src/memory-guard.ts:80` |
| 01.8 | Git failures non-fatal, return `'written'` | ✅ Complete | `src/memory-guard.ts:156-161` |
| 01.9 | Commit subject uses `create` / `update` | ✅ Complete | `src/memory-guard.ts:54-58` |
| 01.10 | `memory-bootstrap.ts` uses guarded path | ✅ Complete | `src/memory-bootstrap.ts:233` |
| 01.11 | TODO in `index.ts` noting tool-use writes bypass guard | ✅ Complete | `src/index.ts:77-80` |
| 01.12 | Implementation Notes document writeContactMemory decision | ❌ Missing | `tasks/main/implementation-notes.md` does not exist |

**Compliance**: 11/12.

### Task 02 — Events + Stats

| # | Requirement | Status | Notes |
|---|---|---|---|
| 02.1 | `events.ts` exports logEvent, EventKind, EventBase, EVENTS_FILE, getEventsPath | ✅ Complete | `src/events.ts:4-44` |
| 02.2 | Appends JSONL, creates parent dir, never throws | ✅ Complete | `src/events.ts:46-60` |
| 02.3 | `skip.not_in_group` logged | ✅ Complete | `src/index.ts:180` |
| 02.4 | `skip.from_me` logged | ✅ Complete | `src/index.ts:187` |
| 02.5 | `skip.not_mentioned` logged | ✅ Complete | `src/index.ts:208` |
| 02.6 | `skip.rate_limited` logged | ✅ Complete | `src/index.ts:219` |
| 02.7 | `reply.sent` logged | ✅ Complete | `src/index.ts:321-329` |
| 02.8 | `reply.silent` logged | ✅ Complete | `src/index.ts:296-305` |
| 02.9 | `error` logged in outer catch | ✅ Complete | `src/index.ts:332` |
| 02.10 | `claude.call` logged in claude.ts | ✅ Complete | `src/claude.ts:54` |
| 02.11 | bootstrap.contact_written / skipped logged | ✅ Complete | `src/memory-bootstrap.ts:181,187,243,248` |
| 02.12 | `npm run stats` works | ✅ Complete | `src/stats.ts:318-340`, `package.json:9` |
| 02.13 | `.gitignore` has `data/events.jsonl` | ✅ Complete | `.gitignore:10` |
| 02.14 | Window filter (24h/7d/30d/all) | ✅ Complete | `src/stats.ts:7-20` |
| 02.15 | Percentile calc | ✅ Complete | `src/stats.ts:57-66` |
| 02.16 | Malformed line skip | ✅ Complete | `src/stats.ts:111-114` |
| 02.17 | Original `console.log` statements retained (additive logging) | ✅ Complete | `src/index.ts:212,218,320`; `src/claude.ts` is new logging only, no console.log removed |

**Compliance**: 17/17. (But see Issue on duplicate `command.received`.)

### Task 03 — Commands

| # | Requirement | Status | Notes |
|---|---|---|---|
| 03.1 | `parseCommand` / `dispatchCommand` / types exported | ✅ Complete | `src/commands.ts:12-53` |
| 03.2 | Self-chat gate: fromMe + self-chat + startsWith `!` | ⚠️ Partial | Gate uses `msg.fromMe` (truthy) instead of `msg.fromMe === true` as specified. Practically equivalent but diverges from spec (§3.1). |
| 03.3 | `!help` | ✅ Complete | `src/commands.ts:91-106` |
| 03.4 | `!remember` | ⚠️ Partial | Works on happy path but ignores guard rejection — see Critical issue |
| 03.5 | `!forget` | ✅ Complete | `src/commands.ts:189-206` |
| 03.6 | `!who` (JID + name search, ambiguity, truncation) | ✅ Complete | `src/commands.ts:208-275` |
| 03.7 | `!status` | ✅ Complete | `src/commands.ts:277-282` |
| 03.8 | `!silence` with `Nm/Nh/Nd` durations | ✅ Complete | `src/commands.ts:63-73,284-306` |
| 03.9 | `!silence all` → global key `*` | ✅ Complete | `src/commands.ts:299` |
| 03.10 | `!resume` | ✅ Complete | `src/commands.ts:308-311` |
| 03.11 | Unknown command fallback | ✅ Complete | `src/commands.ts:350-352` |
| 03.12 | Recursion guard: track outbound IDs for `msg.reply()` AND `chat.sendMessage()` | ✅ Complete | `src/index.ts:161-169` (command), `src/index.ts:310-317` (group reply) |
| 03.13 | Bot replies never start with `!` | ⚠️ Partial | Dispatcher replies themselves don't, but `cmdWho` relays file contents — a memory file starting with `!` would produce a reply starting with `!`. ID-based guard still protects. |
| 03.14 | Silence enforcement in handler | ✅ Complete | `src/index.ts:225-234` |
| 03.15 | README Command Mode section | ✅ Complete | `README.md` (new section added) |
| 03.16 | Dispatcher catches errors, replies with `error: <msg>` | ✅ Complete | `src/commands.ts:356-365` |

**Compliance**: 14/16 fully met, 2 partial.

---

## Issues Found

### Critical (must fix before shipping)

- **`src/memory-guard.ts:80-81`**: Shell injection surface. `execSync` is called with interpolated strings:
  ```
  execSync(`git add -f "${filePath}"`, ...)
  execSync(`git commit -m "${subject}" -m "${body}"`, ...)
  ```
  `subject` is built from `cusJid` and `context.chatName`; `body` is built from `context.reason`. Today the call-sites pass only hardcoded strings (`'bootstrap'`, `'command !remember'`) and JIDs (which are practically safe), so this is not an *active* exploit — but it is one careless future caller away from being one. Any JID, reason, or chatName containing a double-quote, backtick, `$(...)`, or `;` escapes the quoted arg and executes shell. Use `execFileSync('git', ['add', '-f', filePath], ...)` and `execFileSync('git', ['commit', '-m', subject, '-m', body], ...)` — both completely eliminate the class of bug.

- **`src/commands.ts:185-186`**: `!remember` lies about success. The call `await writeContactMemoryGuarded(...)` returns a `GuardResult` that is silently discarded, and the reply always says `ok, remembered: <fact> for <jid>`. If the guard rejects (e.g., the new content exceeds 8KB, or somehow loses the `## Identity` header), the file is not written but Nick is told it was. Fix: branch on `result.status` and reply `rejected: <reason>` on `'rejected'`, else confirm.

### Important (should fix)

- **`src/index.ts:155` + `src/commands.ts:326`**: Duplicate `command.received` events. Both `index.ts` (before dispatch) and `commands.ts:dispatchCommand` emit `logEvent({ kind: 'command.received', ... })` for every command. Every command execution produces two `command.received` rows in `data/events.jsonl`, inflating stats (and potentially confusing future alerting). Pick one site — the dispatcher is the natural place since it runs for all entry points (including tests).

- **`src/index.ts:230` vs `src/commands.ts:299`**: Silence key semantics are divergent and fragile. The command stores silences with the raw user arg (`"mgz"`) while the handler looks up `silences.has(chat.name)` where `chat.name` is WhatsApp's actual group name (often with emoji, casing differences, or trailing spaces). If the user types `!silence mgz 1h` but `chat.name === "MGZ"` or `"mgz "` or `"mgz 🏃"`, the silence never fires. At minimum: normalize both sides (lowercase + trim) before compare, or document the requirement to type the exact name. Preferably: also support partial match (`chat.name.toLowerCase().includes(key.toLowerCase())`).

- **`src/memory-guard.ts:81`**: Commit-message injection via `chatName`. Even after fixing the shell injection (above), a chatName containing `"` or newline characters would still corrupt commit messages. Less severe but worth noting: when `execFileSync` is used, args are passed verbatim — a newline in the subject will land as a newline in the commit message. Consider stripping `\r\n` and trimming `chatName` / `reason` before using them in commit metadata.

- **`tasks/main/implementation-notes.md` missing**: Task 01 explicitly asks the implementer to "document the choice in the task's Implementation Notes" for how `writeContactMemory` vs `writeContactMemoryGuarded` integration was handled. The file does not exist. The chosen approach (keep `writeContactMemory` as raw atomic write; bootstrap uses guarded path; runtime Edit tool bypasses guard entirely — covered by TODO at `src/index.ts:77-80`) is defensible, but it is not documented.

- **`src/commands.test.ts`**: Missing coverage for `!silence` invalid duration path. `parseDuration` returns `null` for bad input and `cmdSilence` replies `"invalid duration. Examples: 30m, 2h, 1d"` — but no test exercises that branch. Similarly, no test for the dispatcher's outer `try/catch` reply-with-`error:`. Not blocking, but the adequacy bar for this task said "every command's happy path" — the negative paths matter here because they are user-facing.

### Minor (nice to fix)

- **`src/index.ts:150`**: Gate condition uses `msg.fromMe` (truthy) instead of `msg.fromMe === true` as `src/extract.ts:11` does and as the task spec (§3.1) prescribes. whatsapp-web.js emits a proper boolean, so functionally identical, but the strict form matches the spec and the project's existing convention.

- **`src/commands.ts:91-98` (HELP_TEXT)**: Defense-in-depth dent — `!help` reply includes "  !help" and similar lines as list items. After `.trim()` those don't start with `!`, so the handler's `startsWith('!')` gate doesn't re-fire on the round-trip. Safe in practice, but the task spec said "enforce this in the dispatcher — prefix every reply with `ok, ` or similar, never with `!`". Ambiguously worded but currently relying solely on the ID-based guard.

- **`src/commands.ts:208-275` (`cmdWho`)**: Returns raw file contents. If a memory file begins with `!` (e.g., "!!!important note..."), the round-tripped reply in the self-chat would start with `!` and be eligible for re-parsing as a command — recursion guard prevents this, but the file-prefix rule in the task spec implicitly assumed content would not start with `!`. Low probability in practice.

- **`src/memory-bootstrap.ts:236`**: Guard rejections share the `skippedClaudeEmpty` counter — the console summary will say `claude returned empty` when the actual reason was e.g. oversized or shrinkage. The structured event correctly says `guard_rejected: <reason>`, so stats are fine. Minor UX confusion in the live bootstrap log.

- **`src/stats.ts:332`**: Uses `require('path').join(...)` inside `main()` despite `path` not being imported at the top of the file. Works because of require semantics, but inconsistent with the ES-import style everywhere else.

- **`src/events.test.ts:100-113`**: The "survives missing parent dir" test comment concedes it cannot actually exercise the missing-dir case (because it shares `getEventsPath()` with the real project's `data/` dir). The test still passes but for an uninteresting reason — it only asserts `existsSync(path)` after calling `logEvent`. This leaves the `mkdirSync(..., { recursive: true })` behavior effectively untested.

- **`src/commands.ts:241`**: `readdirSync(dir).filter(f => f.endsWith('.md'))` — the task spec's name-search says "Grep `data/contacts/` for files matching the name (case-insensitive)". Current code does a case-insensitive *content* grep (`content.toLowerCase().includes(nameLC)`), not a filename match. This means `!who Alice` matches any file whose *contents* mention Alice (e.g., a group chat file that mentions her in facts). Probably intended, but worth confirming with the spec author — the spec's phrasing is ambiguous.

---

## What Looks Good

- **Module boundaries are clean.** `events.ts` is a tiny self-contained appender. `stats.ts` reads `events.jsonl` with no cross-dependencies on runtime state. `commands.ts` takes a `CommandContext` and stays offline from whatsapp-web.js entirely — tests use real fs and a stub `reply`, matching the "mocking discipline" guidance in the task spec.

- **Atomic write pattern preserved.** `atomicWrite` in `memory-guard.ts:40-47` replicates the tmp+rename pattern from `memory.ts:40-46` rather than tangling the two. The file comment explicitly notes the non-circular design choice.

- **Git-failure recovery is the right shape.** Any `execSync` throw caught, warning logged, status downgraded from `'committed'` to `'written'`, file write preserved. Bootstrap correctly handles all three statuses (`src/memory-bootstrap.ts:234-239`).

- **Recursion guard wired at both reply sites.** Command replies via `chat.sendMessage` (`src/index.ts:161-169`) and group replies via `msg.reply` (`src/index.ts:310-317`) both add the returned message's `_serialized` ID to `recentOutboundIds`, with bounded eviction. The handler skips any inbound whose ID is in the set (`src/index.ts:132-136`).

- **Structured logs are additive, not a replacement.** `console.log` for human-readable output remains (`src/index.ts:212,218,320`); `logEvent` runs alongside it. This matches the task brief's "Both go out" directive.

- **Silence gate is placed correctly.** Block happens AFTER the rate-limit reservation but BEFORE the claude call — meaning silenced chats don't burn the rate-limit budget AND don't pay the claude cost (`src/index.ts:222,225-234`).

---

## Test Coverage

| Area | Tests Exist | Coverage Notes |
|---|---|---|
| `memory-guard.ts` corruption rules | Yes | All 4 rules tested with both positive and negative cases |
| `memory-guard.ts` git lifecycle | Yes | Happy path (committed), git-failure recovery, create vs update subjects |
| `events.ts` | Yes | Append, timestamp, multi-write, IO error swallow |
| `stats.ts` windowing | Yes | 24h / 7d / all cases; malformed line skipped |
| `stats.ts` percentiles | Yes | Tolerant assertions on p50/p95/p99 |
| `stats.ts` formatter | Partial | Only asserts headers + reply count, not the full template |
| `commands.ts` parser | Yes | All edge cases from the spec |
| `commands.ts` dispatcher (happy paths) | Yes | Every command has a happy-path test |
| `commands.ts` dispatcher (error paths) | No | No test for `!silence <bad-duration>`, no test for command throwing → reply `error:` |
| `commands.ts` silence enforcement in runtime | No | No handler-level test exists (acceptable — task spec didn't require it) |
| Recursion guard | No | Not unit-tested; exercised only in integration |

**Test Coverage Assessment**: Strong on the data-layer modules (guard, events, stats). Commands have full happy-path coverage but lack two user-visible error branches. Recursion guard is untested but is a small amount of code with a clear invariant.

---

## Test Execution

| Check | Result | Details |
|---|---|---|
| Test command discovered | Yes (`npm test` → `vitest run`) | `package.json:11` |
| Test suite run | Passed (134/134, 10 files) | 790ms; no skipped, no warnings |
| Build check | Passed (`tsc` exit 0) | `package.json:10` |
| TDD evidence in implementation notes | N/A | `tasks/main/implementation-notes.md` does not exist — see Important issue |

**Test Execution Assessment**: Clean green run. Test count grew from 76 baseline → 134, a +58 increase consistent with the new modules. Build is green.

---

## TDD Compliance

| Task | Tests Written | Tests Adequate | TDD Skipped Reason Valid | Notes |
|---|---|---|---|---|
| 01 — Memory Guard | Yes | Yes | N/A | All 13 specified test behaviors present. Git-verification goes through real `execSync` on a real temp repo as the spec directed. |
| 02 — Events + Stats | Yes | Yes | N/A | 5 events tests + 13 stats tests. Window filter and percentile tests use explicit ISO timestamps (spec-compliant), no Date mocking. |
| 03 — Commands | Yes | Mostly | N/A | Parser tests are complete; dispatcher happy paths covered; error branches (bad duration, thrown error) not covered. |

**TDD Assessment**: Tests are genuine specifications — they call real code, use real fs with temp dirs, and assert on specific values (commit message strings, reply content, file contents). No trivial `toBeDefined()` assertions. Mocking discipline is good (stub `reply` for commands, real git for guard, no fs mocks).

**Test Adequacy**: ~44 new test cases; ~42 are meaningful and specific. The 2 weak ones: (a) `events.test.ts:100-113` "survives missing parent dir" admits in a comment that it can't actually exercise the delete-data-dir case; (b) `stats.test.ts:173-181` `formatStats` "shows reply count" only asserts the output contains the string `'2'` — a formatter regression that printed a totally different number format could pass this test.

---

## Implementation Decision Review

| Task | Decisions Documented | Decisions Sound | Flags |
|---|---|---|---|
| 01 | No (file missing) | Yes | `writeContactMemory` kept raw, bootstrap uses guarded path, runtime Edit tool bypasses guard with a TODO — defensible but undocumented |
| 02 | No (file missing) | Yes | Additive logging pattern implemented cleanly |
| 03 | No (file missing) | Mostly | Silence key uses raw user input without normalization — a decision that should be flagged |

**Decision Assessment**: The architectural decisions made appear sound, but the absence of `tasks/main/implementation-notes.md` means reviewers have to reverse-engineer intent from code and commit history. Task 01 explicitly asked for this file. Create it before committing.

---

## Plan Review

### Dependency Graph

| Task | Depends On | Status |
|---|---|---|
| task-01 | None | ✅ Valid |
| task-02 | None | ✅ Valid |
| task-03 | task-02 (for `events.ts`) | ✅ Valid — task-02 is indeed merged alongside |

**Dependency Assessment**: No issues found. Task 03 correctly declares its dependency on task 02 for the events module (used by `!status`).

### PRD Coverage

The PRD here is `docs/architecture-improvements.md` items 1, 2, 4, 5.

| PRD Item | Covered By | Status |
|---|---|---|
| Item 1: Git-version memory files | task-01 | ✅ Covered |
| Item 2: Corruption guard on Edit | task-01 | ✅ Covered |
| Item 4: Structured logs + `npm run stats` | task-02 | ✅ Covered |
| Item 5: Command-mode self-chat | task-03 | ✅ Covered |
| Item 4 sub-req: token/cost extraction | task-02 (deferred) | ⚠️ Stubbed — fields always undefined; task-02 §3 notes this is intentional for now |
| Item 5 sub-req: `!bootstrap` command | Not in v1 scope | ⚠️ task-03 dropped this command (spec §3 omitted it) |
| Item 5 sub-req: `!voice refresh` command | Not in v1 scope | ⚠️ task-03 dropped this command |

**Coverage Score**: 4/4 headline items covered; 2 sub-commands from item 5 were deliberately dropped from v1 scope (consistent with task-03's stated command list).

### File Conflict Analysis

| File | Tasks Touching It | Conflict? |
|---|---|---|
| `src/index.ts` | task-02 (events) + task-03 (self-chat gate + silence) | ⚠️ Concurrent writes — but task-03 depends on task-02, so ordered. Final file combines both cleanly. |
| `src/memory-bootstrap.ts` | task-01 (guarded write) + task-02 (events) | ⚠️ Concurrent writes, no declared dependency. Final file merges both, but this could have been a merge conflict. |
| `src/memory.ts` | task-01 only | ✅ No conflict |
| `.gitignore` | task-02 only | ✅ No conflict |
| `package.json` | task-02 only | ✅ No conflict |
| `README.md` | task-03 only | ✅ No conflict |

**Conflict Assessment**: `src/memory-bootstrap.ts` is modified by both task-01 (change writeContactMemory → writeContactMemoryGuarded) and task-02 (add logEvent calls). Task files do not declare this. In practice the changes are orthogonal (different lines) and the merged result is coherent, but if these tasks had been implemented by different agents in parallel they could have race-conflicted.

### Task Sizing

| Task | Assessment | Notes |
|---|---|---|
| task-01 | ✅ Well-sized | One coherent module (+ test) + 1 integration point |
| task-02 | ✅ Well-sized | Two modules (events + stats) + instrumentation at known sites |
| task-03 | ⚠️ Slightly oversized | Command parser + 7 commands + runtime gate + recursion guard + README. Acceptable because commands are small and similar, but this is the biggest task and the one with the most partial-completion risk. |

### TDD Spec Consistency

| Task | Has TDD Section | Framework Valid | Command Valid | Status |
|---|---|---|---|---|
| task-01 | Yes | Yes (Vitest — matches repo) | Yes (`npm test` → `vitest run`) | ✅ |
| task-02 | Yes | Yes | Yes | ✅ |
| task-03 | Yes | Yes | Yes | ✅ |

**TDD Spec Assessment**: All three task files specify Vitest and reference the `npm test` command — both real and consistent with the repo.

### Plan Issues Found

#### Critical (blocks implementation)
- None

#### Important (should fix before proceeding)
- `src/memory-bootstrap.ts` is modified by both task-01 and task-02 without a declared dependency. No actual conflict occurred this round but this is the kind of implicit coupling that bites parallel execution. Either task-02 should declare an ordering dependency on task-01, or the task files should explicitly call out the shared file and split instrumentation into a deferred follow-up.

#### Minor (nice to fix)
- `tasks/main/implementation-notes.md` is missing. Task 01 explicitly asks for it. Create it before closing this batch.
- Task-03 command set dropped `!bootstrap` and `!voice refresh` from the PRD's list. Intentional and reasonable for v1, but the deviation is not called out in the task file — a future reviewer may flag it as a gap.

---

## Recommendations

Ordered by priority:

1. **Fix the shell injection.** Replace both `execSync` calls in `src/memory-guard.ts:80-81` with `execFileSync('git', [...])` passing args as an array. Low-effort, defensive, closes a real class of bug.
2. **Fix `!remember` false confirmation.** `src/commands.ts:185-186` should branch on `result.status` and reply `rejected: <reason>` on `'rejected'`.
3. **De-duplicate `command.received` events.** Remove the call at `src/index.ts:155` and keep only the one in `src/commands.ts:326` (dispatcher-side is canonical).
4. **Normalize silence keys.** At minimum, lowercase + trim both sides of the `silences.has(chat.name)` compare. Ideally, support substring match so `!silence mgz` matches `"MGZ 🏃"`.
5. **Write `tasks/main/implementation-notes.md`.** Document: (a) why `writeContactMemory` was kept raw and `writeContactMemoryGuarded` added as a second export rather than routing through the guard unconditionally; (b) the runtime-Edit-tool-bypass TODO and how a future task would close it; (c) the silence-key normalization decision (current: none); (d) the duplicate-command.received decision (after fix).
6. **Add negative-path tests** for `!silence <bad-duration>` and for the dispatcher's outer catch → `error:` reply.
7. **Harden commit metadata.** Even after fix (1), strip newlines and quotes from `chatName` / `reason` before using them in commit subjects/bodies.
8. **Minor cleanups.** Strict `=== true` in `src/index.ts:150`; import `path` at top of `src/stats.ts` instead of in-line `require`.
