# Code Review Report — Ambient Reply Feature

## Summary

The ambient reply feature is implemented cleanly across both tasks and is close to ship-ready. 196/196 tests pass, build is clean, safety defaults are correct (`masterEnabled: false`), gate ordering matches spec, atomic writes are used, and the runtime integration respects existing gates (group, fromMe, rate-limit, silence). One small user-visible arithmetic bug in `!ambient status` (negative memory count when sources overlap) and a handful of minor polish items. No critical issues.

## PRD Compliance

| # | Requirement | Status | Notes |
|---|-------------|--------|-------|
| 1 | `src/fuzzy.ts` exports normalize, diceSimilarity, bestFuzzyMatch | Complete | Plus `FuzzyMatch` interface |
| 2 | `src/ambient.ts` exports listed functions + AmbientConfig | Complete | All present |
| 3 | Config I/O uses atomic tmp+rename | Complete | `saveAmbientConfig` uses `tmp-<pid>-<ts>` then `rename` |
| 4 | `shouldAmbientReply` implements all 6 gates in order | Complete | master → disabledGroups → dailyCap → short msg → empty bank → fuzzy |
| 5 | `loadMemoryTopics` parses `## Recurring topics` sections | Complete | Case-insensitive header match, stops at next `##` |
| 6 | `buildTopicBank` merges + dedupes 3 sources | Complete | Lowercases+trims each entry; dedups via Set |
| 7 | `AMBIENT_PROMPT_PREFIX` + `VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT` exported | Complete | Text matches spec verbatim |
| 8 | EventKind gains 5 new values | Complete | All five added as pure union additions |
| 9 | `.gitignore` has `data/ambient-config.json` | Complete | Line 11 |
| 10 | Default `masterEnabled = false` | Complete | `defaultAmbientConfig()` returns false |
| 11 | `!ambient on/off/on<chat>/off<chat>/status/cap/threshold/refresh` | Complete | All sub-commands implemented |
| 12 | `!topic add/remove/list` | Complete | All sub-commands implemented |
| 13 | Chat-name normalization (lowercase+trim) for disabledGroups | Complete | Uses `normalizeChatKey` in both store + lookup |
| 14 | Ambient path runs ONLY after group-check and fromMe-check | Complete | Ambient path at line 215-252, after gates 1 & 2 |
| 15 | `AMBIENT_PROMPT_PREFIX` prepended only when trigger==='ambient' | Complete | Ternary on line 331-332 |
| 16 | Rate-limit (10s) still applies to ambient | Complete | Rate-limit check happens AFTER ambient gate at line 259 |
| 17 | Successful ambient reply records to repliesToday and emits ambient.replied | Complete | Lines 368-372 |
| 18 | Empty claude response for ambient emits ambient.declined | Complete | Lines 340-343 |
| 19 | Ambient skipped emits ambient.skipped with reason | Complete | Lines 231-239 |
| 20 | No hardcoded reply prefix ("falando nisso") — voice profile governs | Complete | Prompt instructs Claude NOT to use that phrase |
| 21 | `!ambient on` = global; `!ambient off <chat>` = per-group opt-OUT | Complete | Blocklist semantics verified |
| 22 | Fuzzy with threshold, not substring | Complete | Dice bigram similarity with configurable threshold |
| 23 | `extractVoiceProfileTopics` + `maybeRefreshVoiceProfileTopics` | Complete | Mtime-gated refresh, returns [] on failure, never throws |
| 24 | README has Ambient Replies section | Complete | Lines 125-165 |
| 25 | `npm run build` exits 0 | Complete | Verified |
| 26 | `npm test` passes (existing 139 + new) | Complete | 196/196 pass |

**Compliance Score**: 26/26 requirements fully met

## Issues Found

### Critical (must fix before shipping)

- None

### Important (should fix)

- **`src/commands.ts:403`**: `!ambient status` reports memory count via `topicBank.length - cfg.explicitTopics.length - cfg.voiceProfileTopics.length`. This is incorrect whenever topics overlap across sources. Example: explicit=["tennis"], voice=["tennis","startups"], memory=[] → `topicBank=["tennis","startups"]` (size 2), formula yields `2 - 1 - 2 = -1`. The status line will show "memory: -1" to the user. Fix: compute `memoryTopics = loadMemoryTopics()` explicitly and report `memoryTopics.length` (pre-dedupe) or compute the post-dedupe memory contribution by tracking origins during the merge. No existing test caught this because `commands.test.ts:483-492` only asserts that master/cap/threshold keywords appear, not the arithmetic.

- **No `tasks/main/implementation-notes.md` exists**: The spec in both tasks required TDD mode and non-trivial architectural additions (new fuzzy module, config I/O, integration into index.ts). Implementation notes documenting decisions (e.g., dice vs Levenshtein, double `ensureDailyReset` call in `recordAmbientReply+index.ts`, why rate-limit runs after ambient gate instead of before) would help future reviewers/implementers calibrate. Not a blocker for this ship, but flag for future tasks.

### Minor (nice to fix)

- **`src/commands.ts:465-472`**: `!topic add <existing>` replies `ok, added ${phrase}` even when the phrase was already in the list. User-facing message is slightly misleading — something like `ok, ${phrase} already in list. total: N` would be more accurate. (Task 02 test #13 only asserts that duplicates are not added — not the reply wording.)

- **`src/index.ts:369`**: `recordAmbientReply(ensureDailyReset(loadAmbientConfig()))` — `recordAmbientReply` itself calls `ensureDailyReset` internally (see `ambient.ts:224`), so the outer `ensureDailyReset` is redundant. Harmless but untidy.

- **`src/index.ts:266-276`**: The silence check fires AFTER the ambient gate. A chat muted via `!silence` will still trigger topic-bank build + `ambient.considered` event before being rejected at the silence check. For correctness this is fine (and matches spec intent — ambient is still gated by silence), but it means the `ambient.considered` event count in stats can over-count for muted chats. Consider moving the silence check before the ambient gate, or adding a pre-check to skip ambient when silenced.

- **`src/commands.ts:433-443`**: `!ambient refresh` reply is `ok, refreshed: voice=<n> memory=<m> total=<k>` — spec specified `ok, refreshed: voice=<n> memory=<m>`. The added `total=` is harmless but a small spec deviation.

- **`src/prompts.test.ts`**: No test for `AMBIENT_PROMPT_PREFIX` or `VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT` — a simple smoke test that the `{VOICE_PROFILE}` placeholder fills without orphans would catch regressions if the template structure changes.

- **`src/commands.ts:111-122`**: `HELP_TEXT` constant lists new commands — good. But commands.test.ts:78-89 (`dispatchCommand — !help`) doesn't assert that `!ambient` or `!topic` appear, so a regression that drops them from help wouldn't be caught. Low-risk gap.

- **`src/ambient.ts:282`**: `maybeRefreshVoiceProfileTopics` catches the `statSync` error with `catch {}` and returns `{ refreshed: false, count: 0 }` for any error (not just ENOENT). If permissions/IO fail for reasons other than "file missing", the user gets no warning. Consider differentiating ENOENT from other errors, matching the pattern in `loadMemoryTopics` (line 115).

## What Looks Good

- **Gate ordering**: `shouldAmbientReply` implements the 6 gates in exactly the documented order. Tests cover each failure branch (master, disabledGroups, cap, short, empty-bank, no-match) and the happy path.
- **Default safety**: `masterEnabled: false` in `defaultAmbientConfig()` and persists from the shipped path. `loadAmbientConfig` returns defaults on both missing-file and malformed-JSON. Test coverage for both.
- **Atomic writes**: `saveAmbientConfig` uses `tmp-<pid>-<ts>` + `renameSync`. Test `saveAmbientConfig atomic write` checks no `.tmp-` files remain.
- **Chat-name normalization**: `normalizeChatKey` (`.trim().toLowerCase()`) used consistently in both `shouldAmbientReply` (comparing stored group key against incoming chat name) and all `!ambient on/off <chat>` command paths. `ambient.test.ts` covers the mixed-case case at line 259-268. `commands.test.ts` covers at test #4.
- **Rate-limit and silence**: existing per-group 10s rate limit applies uniformly to ambient (reuses `lastReplyAt` map) — correct reuse of existing infrastructure.
- **Ambient prompt prefix**: Prepended ONLY when trigger is `'ambient'`; `RUNTIME_PROMPT` structure is not modified. The prefix explicitly forbids "falando nisso" / "just saw this" and instructs Claude that empty output is the right answer most of the time.
- **Trigger union extension**: Cleanly extended `'mention' | 'reply' | null` to `'mention' | 'reply' | 'ambient' | null` throughout the handler with no type-errors.
- **Event kinds**: All 5 new event kinds added as pure union additions — no existing event code touched.
- **Claude extraction via existing pattern**: `extractVoiceProfileTopics` uses the `_config.command` swap pattern from `claude.test.ts` for deterministic test output, avoiding real subprocess calls.
- **Mtime-gated refresh**: `maybeRefreshVoiceProfileTopics` only re-runs claude when the voice profile's mtime changed, which avoids unnecessary API calls.
- **Command structure**: `dispatchCommand` catches and logs errors uniformly; commands never throw out of the handler.

## Test Coverage

| Area | Tests Exist | Coverage Notes |
|------|-------------|----------------|
| `fuzzy.normalize` | Yes | Lowercase, diacritics, punctuation, whitespace — all 4 spec cases covered |
| `fuzzy.diceSimilarity` | Yes | Identical, disjoint, similar, case-insensitive |
| `fuzzy.bestFuzzyMatch` | Yes | Top match, threshold respect, empty bank, empty body, fuzzy typo, threshold=0 |
| `ambient.defaultAmbientConfig`/load/save | Yes | Defaults, malformed JSON, round-trip, atomic write |
| `ambient.ensureDailyReset` | Yes | New day, same day |
| `ambient.loadMemoryTopics` | Yes | Multi-file merge+dedupe, empty dir, files without section |
| `ambient.buildTopicBank` | Yes | Merge, dedupe |
| `ambient.shouldAmbientReply` | Yes | All 6 gate failures + happy path + chat normalization |
| `ambient.recordAmbientReply` | Yes | Append timestamp, daily reset trigger |
| `ambient.extractVoiceProfileTopics` | Yes | Parse, dedupe, cap 20, missing file, claude fails |
| `!ambient on/off` | Yes | master flags, normalization |
| `!ambient off <chat>` | Yes | Normalization, add/remove from disabledGroups |
| `!ambient status` | Partial | Only asserts keywords — does NOT catch arithmetic bug |
| `!ambient cap/threshold` | Yes | Valid + invalid input both tested |
| `!ambient refresh` | No | No unit test for the sub-command (extractor itself is tested) |
| `!topic add/remove/list` | Yes | Add, normalize, dedupe, remove missing, list all sources |
| `AMBIENT_PROMPT_PREFIX` prepended on ambient trigger | No | No integration test; relies on visual code review |
| Ambient path filters + emits correct events | No | No integration test; structural correctness verified by inspection |
| Rate-limit applies to ambient | No | Not explicitly tested; relies on shared code path |

**Test Coverage Assessment**: Core pure-logic modules (fuzzy, ambient gate, config I/O, memory parsing, extractor) are thoroughly tested. Command handlers well covered. Runtime integration tests are absent — acceptable given `src/index.ts` has never had a full integration test (the existing `index.test.ts` only covers pure helpers), but the ambient-specific event emissions and rate-limit/ambient interplay would benefit from at least one integration test in the future.

## Test Execution

| Check | Result | Details |
|-------|--------|---------|
| Test command discovered | Yes (`npm test` → `vitest run`) | From `package.json:11` |
| Test suite run | Passed (196/196) | 12 test files pass; pre-existing puppeteer `Unhandled Rejection` from `index.test.ts` running full main() is unrelated to this change |
| TDD evidence in implementation notes | N/A | `implementation-notes.md` is absent; the code structure + test-first names (e.g., numbered test comments matching spec) indicate TDD was likely followed |

**Test Execution Assessment**: All 196 tests pass. Build is clean. The pre-existing unhandled puppeteer rejection is unrelated to the ambient feature (it's from `index.test.ts` importing `./index` which has a side effect of `main().catch(...)` at module top-level — this predates this batch of changes).

## TDD Compliance

| Task | Tests Written | Tests Adequate | TDD Skipped Reason Valid | Notes |
|------|---------------|---------------|-------------------------|-------|
| task-01-ambient-infra | Yes | Yes | N/A | All 13 fuzzy cases + all 18 ambient cases from spec present |
| task-02-ambient-integration | Yes | Yes | N/A | All 16 command cases + 5 extractor cases present |

**TDD Assessment**: Tests map tightly to spec-enumerated test cases (numbered 1–18 for ambient, 1–16 for commands, 17–21 for extractor). Tests call real code, real fs, real dice scorer; mocking is kept at the system boundary (the claude subprocess via `_config.command`), which matches this project's conventions.

**Test Adequacy**: 42/44 tests are meaningful and specific. 2 tests flagged as weak:
- `commands.test.ts:484-492` (`!ambient status`) only asserts that `master`/`cap`/`threshold` substrings appear. Does not check the `memory:` count is non-negative or numerically correct — this is how the arithmetic bug at `commands.ts:403` slipped through.
- `commands.test.ts:78-89` (`!help`) does not assert `!ambient` or `!topic` appear — a regression that drops them from help would not be caught.

Other tests use real assertions with specific expected values (`toBe`, `toEqual`, `toContain`, numeric comparisons). Mocking discipline is correct: only `_config.command` (system boundary) is swapped in extractor tests; no internal modules are mocked.

## Plan Review

### Dependency Graph

| Task | Depends On | Status |
|------|-----------|--------|
| task-01-ambient-infra | None | Valid |
| task-02-ambient-integration | task-01 | Valid |

**Dependency Assessment**: No issues found. Task 02 correctly declares dependency on Task 01 (it needs the exports from `src/ambient.ts`, `src/fuzzy.ts`, and the new prompt + event additions). No circular deps; no phantom refs.

### PRD Coverage

| PRD Requirement | Covered By | Status |
|----------------|-----------|--------|
| Fuzzy match (threshold, not substring) | task-01 + implementation | Covered |
| Hybrid topic source (explicit + voice + memory) | task-01 | Covered |
| Daily cap (default 30, adjustable via !ambient cap) | task-01 + task-02 | Covered |
| Per-group rate limit still applies (reuse lastReplyAt) | task-02 | Covered |
| No hardcoded reply prefix (voice profile governs) | task-01 (AMBIENT_PROMPT_PREFIX) | Covered |
| `!ambient on` = global, `!ambient off <chat>` = blocklist | task-02 | Covered |
| Off by default | task-01 (defaultAmbientConfig) | Covered |
| `!ambient refresh` rebuilds voice + memory | task-02 | Covered |
| `!topic` add/remove/list | task-02 | Covered |
| Ambient uses AMBIENT_PROMPT_PREFIX + RUNTIME_PROMPT | task-02 | Covered |
| `ambient.skipped`/`considered`/`replied`/`declined` events | task-01 (enum) + task-02 (wiring) | Covered |
| README updated with ambient section | task-02 | Covered |

**Coverage Score**: 12/12 requirements covered

### File Conflict Analysis

| File | Tasks Touching It | Conflict? |
|------|------------------|-----------|
| `src/fuzzy.ts` | task-01 | No conflict (new file, single task) |
| `src/ambient.ts` | task-01, task-02 | Ordered (task-02 depends on task-01) |
| `src/ambient.test.ts` | task-01, task-02 | Ordered (task-02 appends extractor tests) |
| `src/prompts.ts` | task-01 | No conflict (single task adds exports) |
| `src/events.ts` | task-01 | No conflict (single task adds enum values) |
| `src/commands.ts` | task-02 | No conflict |
| `src/commands.test.ts` | task-02 | No conflict |
| `src/index.ts` | task-02 | No conflict |
| `README.md` | task-02 | No conflict |
| `.gitignore` | task-01 | No conflict |

**Conflict Assessment**: No conflicts detected.

### Task Sizing

| Task | Assessment | Notes |
|------|-----------|-------|
| task-01-ambient-infra | Well-sized | 5 files, clear scope (pure-logic foundation), self-contained |
| task-02-ambient-integration | Well-sized | 6 files, builds on task-01, scope is runtime wiring + commands + README |

### TDD Spec Consistency

| Task | Has TDD Section | Framework Valid | Command Valid | Status |
|------|----------------|-----------------|--------------|--------|
| task-01-ambient-infra | Yes | Yes (Vitest) | Yes (`npm test`) | OK |
| task-02-ambient-integration | Yes | Yes (Vitest) | Yes (`npm test`) | OK |

**TDD Spec Assessment**: Both tasks reference Vitest (correct — used throughout repo) and `npm test` (correct — matches package.json). Test file paths (`src/fuzzy.test.ts`, `src/ambient.test.ts`, `src/commands.test.ts`) follow the project's colocation convention.

### Plan Issues Found

#### Critical (blocks implementation)
- None

#### Important (should fix before proceeding)
- None

#### Minor (nice to fix)
- None

## Implementation Decision Review

| Task | Decisions Documented | Decisions Sound | Flags |
|------|---------------------|----------------|-------|
| task-01-ambient-infra | No (no implementation-notes.md) | Yes (from code) | None |
| task-02-ambient-integration | No (no implementation-notes.md) | Yes (from code) | None |

**Decision Assessment**: No `implementation-notes.md` exists — the implementer did not document reasoning. Based on code inspection, decisions look sound: dice bigram is a standard choice for fuzzy matching, `_config.command` swap for extractor tests matches the existing project convention, mtime-gated voice profile refresh avoids unnecessary claude calls, and the trigger union was extended rather than overloaded. The one arithmetic bug in `!ambient status` (memory count via subtraction) suggests the implementer did not test manually after shipping — a quick `!ambient status` run would have surfaced the negative count.

## Recommendations

1. **Fix the `!ambient status` memory count arithmetic** (`src/commands.ts:403`). Use `loadMemoryTopics().length` directly instead of subtracting from the deduped bank. Add a test that asserts the count is non-negative with overlapping sources.
2. **Improve `!topic add` duplicate reply wording** so users know when a phrase was already present.
3. **Remove the redundant `ensureDailyReset` call** in `src/index.ts:369` (the wrapped `recordAmbientReply` already does it).
4. **Optionally**: add a smoke test for `AMBIENT_PROMPT_PREFIX` in `prompts.test.ts`, and assert that `!ambient`/`!topic` appear in `!help` output in `commands.test.ts`.
5. **Future**: add an `implementation-notes.md` for this batch documenting why dice bigram (vs Levenshtein) was chosen, why `_config.command` swap is used for extractor tests, and the design choice of running the silence gate after the ambient gate rather than before.
