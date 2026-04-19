# Code Review Report — Group Message Archive + `!summary` Command

## Summary

The feature is implemented cleanly across `src/groups.ts` (Task 01) and the
runtime/command wiring in `src/index.ts`, `src/commands.ts`, `src/events.ts`,
`src/prompts.ts`, and `README.md` (Task 02). 248/248 tests pass, `tsc` is
clean, and the design matches the shared-context spec: local-date bucketing,
JID-keyed manifest, non-fatal persist errors, fuzzy group matching, proper
handler ordering (persist BEFORE `fromMe` gate, AFTER `getChat()`). No
critical blockers. A handful of important polish items and a couple of
minor improvements worth addressing before calling this done.

## PRD Compliance

| # | Requirement (Task 01) | Status | Notes |
|---|-----------------------|--------|-------|
| 1 | Types: `PersistedMessage`, `GroupIndexEntry`, `GroupIndex`, `GroupMatch` exported | ✅ | All shapes match spec |
| 2 | Path helpers (`GROUPS_DIR`, `groupsDirAbs`, `indexPath`, `groupFolderPath`, `dayFilePath`) | ✅ | All cwd-relative, resolved at call time |
| 3 | `slugifyGroupName(name, fallback)` handles accents, emojis, punctuation, collapse, trim | ✅ | Correctly uses `normalize()` from fuzzy.ts plus extra ASCII-only pass to strip residual Unicode letters |
| 4 | `loadGroupIndex`/`saveGroupIndex` — atomic tmp+rename, never throws on load | ✅ | Matches memory.ts pattern |
| 5 | `ensureGroupFolder` — collision `-2`/`-3` suffixing | ✅ | Counter loop correctly increments over existing `usedFolders` set |
| 6 | `persistMessage` — append-only JSONL, swallows fs errors | ✅ | Sync append, trailing `\n`, catches and warns |
| 7 | `readDayMessages` — returns in file order, skips malformed lines with one warning | ✅ | Missing file → `[]`, correct |
| 8 | `listDays` — sorted desc, empty on missing dir | ✅ | Regex filter tight (`^\d{4}-\d{2}-\d{2}\.jsonl$`) |
| 9 | `findGroupsByName` — 0.4 threshold dice similarity, sorted desc | ✅ | Matches spec |
| 10 | `localDate` — local timezone, not UTC | ✅ | Uses `toLocaleDateString('en-CA')` |
| 11 | `data/groups/` added to `.gitignore` | ✅ | Appended at end of file |

| # | Requirement (Task 02) | Status | Notes |
|---|-----------------------|--------|-------|
| 12 | `SUMMARY_PROMPT` exported from `src/prompts.ts` | ✅ | Exact spec wording |
| 13 | `!summary` wired in dispatcher; `HELP_TEXT` updated | ✅ | Case added to switch |
| 14 | `parseDateSpec` exported, covers today/undefined/empty/yesterday/Nd/YYYY-MM-DD/null | ✅ | Uses `localDate(Date.now()-Nd*ms)` |
| 15 | `persistMessage` called early in handler, errors swallowed | ✅ | Placed AFTER `chat.isGroup` check, BEFORE `fromMe` gate |
| 16 | System-message types NOT persisted | ✅ | SYSTEM_TYPES set includes all 5 spec types plus `revoked`/`call_log` |
| 17 | `!summary` covers: no match, multi-match, empty day, happy path, claude error | ✅ | All branches present, log events emitted |
| 18 | New EventKind values added | ✅ | `group.persisted`, `summary.requested/no_match/multi_match/empty/generated/error` |
| 19 | README new section documented | ✅ | Layout, folder-naming rule, command examples |
| 20 | `npm run build` exits 0, tests all green | ✅ | 248 tests pass, tsc clean |

**Compliance Score**: 20/20 requirements fully met.

## Issues Found

### Critical (must fix before shipping)

_None._

### Important (should fix)

- **`src/index.ts:212`**: For Nick's own messages (`msg.fromMe === true`),
  `fromJid` falls through to `msg.author ?? msg.from ?? ''`. In
  whatsapp-web.js, `msg.from` on an outgoing group message is the SENDER's
  JID in most cases but `msg.author` is typically unset — the resulting
  `from_jid` is usually Nick's own JID, not the group JID, so this is not
  a data-corruption bug. However, it is fragile and variant across
  whatsapp-web.js versions. Prefer deriving Nick's JID explicitly from
  `ownerCusId` (already in scope from line 104) when `msg.fromMe` is true.
  Without this fix, `from_jid` may be empty or wrong for Nick's own rows,
  which complicates future per-sender filtering of the archive.

- **`src/prompts.ts:224` (`fillTemplate`)**: `String.prototype.replace`
  interprets `$&`, `$1`-`$9`, `$$` in the replacement string. The
  `MESSAGES` and `GROUP_NAME` vars now carry raw user-generated content
  from WhatsApp (group name, message bodies). A message containing a
  literal `$&` would be replaced with `{MESSAGES}`, and `$$` collapses to
  `$`. This is a pre-existing hazard in fillTemplate that was
  previously safe because all inputs were trusted; the summary feature is
  the first to pipe arbitrary user text through it. Either escape `$`
  runs in values (`replace(/\$/g, '$$$$')`) or use a function-replacement
  form. Will not break any test here — just silently mangles certain
  messages in summaries.

- **`src/commands.test.ts:769` ("happy path" test)**: the stub claude
  command echoes a fixed "Summary!" regardless of what the prompt
  contains. The test verifies the reply contains "Summary!" but does NOT
  verify that the prompt was constructed correctly (that the seeded
  messages were formatted into `[HH:MM] <name>: <body>` lines, that
  `(me)` suffix was applied for Nick's row, or that GROUP_NAME/DATE were
  substituted). A regression that broke message formatting or the
  `(me)` annotation would pass this test. Consider capturing the stdin
  that the subprocess receives (write it to a temp file via
  `process.stdin.pipe(fs.createWriteStream(...))` in the stub) and
  asserting the formatted lines appear there.

- **`src/groups.test.ts:319` (`localDate` test)**: the assertion only
  checks `result.startsWith('2026-04-')` and that it matches
  `^\d{4}-\d{2}-\d{2}$`. This passes even if `localDate` returned the
  UTC date by mistake — the whole point of the function is that it must
  NOT return the UTC date. For a mid-day UTC timestamp the local date
  will usually also be `2026-04-18`, so this is not a strong test.
  Consider: pass a timestamp near UTC midnight (e.g.
  `2026-04-18T23:30:00Z`) and assert the result differs from
  `new Date(tsMs).toISOString().slice(0,10)` when the test machine's
  offset moves the local day forward.

### Minor (nice to fix)

- **`src/index.ts:197`**: `SYSTEM_TYPES` is re-allocated on every group
  message. Move to module scope. (The set also includes `revoked` and
  `call_log` beyond the spec's five; this is reasonable — a deleted-
  message notification has no archival value — but worth a comment
  explaining the deviation.)

- **`src/index.ts:222`/`234`**: `localDate(tsMs)` is called twice (once
  for the `local_date` field, once for the debug log). Compute once and
  reuse.

- **`src/groups.ts:83`**: The second `replace(/[^a-z0-9-]/g, '-')` pass
  after the whitespace step is worth a comment — `normalize()` preserves
  Unicode letters (`\p{L}`) but slugify wants ASCII-only folder names,
  and this line is what strips e.g. Chinese characters. Currently reads
  as "residual" which undersells its role.

- **`src/commands.ts:556` (`cmdSummary`)**: no test for the "null
  parseDateSpec → usage error" branch (e.g. `!summary mgz foobar`). The
  code path is live but untested.

- **`src/commands.ts:595` ("no messages" reply)**: the reply format is
  `no messages for ${match.name} on ${targetDate}`. Spec phrasing is
  `"no messages for <group> on <date>"` — matches. Fine.

- **`src/index.ts:230`**: `quoted_id` is always `null` even when
  `has_quoted: true`. Noted in task spec as `quoted_id: null` in the
  example record, so spec-conformant, but it means summaries cannot link
  quoted messages. If that's desired later, an `await msg.getQuotedMessage()`
  with timeout + fallback would be the path.

- **`src/groups.ts:264` (`findGroupsByName`)**: no upper bound on number
  of matches returned. For an index with ~50 groups and a short query
  that fuzzy-matches many (e.g. single character), the reply could be
  spammy. Not a bug — just a consideration for later.

- **`tasks/main/implementation-notes.md`**: does not exist. Both tasks
  made some non-obvious choices (SYSTEM_TYPES superset, reusing
  `fuzzy.normalize()` plus a second ASCII pass in slugify, choosing
  `toLocaleDateString('en-CA')` over manual assembly). A short notes
  file would help the next reviewer.

## What Looks Good

- `src/groups.ts` is tidy, well-commented, and isolates each concern
  into a single function. Reuse of `normalize()` and `diceSimilarity()`
  from `src/fuzzy.ts` is exactly right.
- Atomic write of `.index.json` via tmp+rename matches the established
  `memory.ts` pattern.
- Handler ordering in `src/index.ts` is correct: persist runs AFTER
  `getChat()` (necessary — we need `chat.name` and `chat.id`), AFTER the
  `isGroup` check, BEFORE the `fromMe` gate (so Nick's own messages are
  archived for complete summaries), and is wrapped in try/catch so a
  persist failure cannot break the rest of the handler.
- System-message filtering uses `msg.type`, not a heuristic on body —
  robust.
- JSONL newline-terminated append means partial-write on power loss
  leaves a trailing malformed line that the reader skips gracefully.
  The reader warns once per invocation rather than per-line, which is
  good.
- `parseDateSpec` is a pure function with clean semantics; tests cover
  today/undefined/empty/yesterday/Nd/ISO/invalid.
- `.gitignore` entry for `data/groups/` is in place. Nothing group-
  related leaks into the staging area.
- `README.md` section matches the spec prose closely.
- `!summary` event-log surface is complete: `requested`, `no_match`,
  `multi_match`, `empty`, `generated` (with `msg_count` and
  `duration_ms`), `error` (with `reason`). Good observability.

## Test Coverage

| Area | Tests Exist | Coverage Notes |
|------|-------------|----------------|
| `slugifyGroupName` | Yes (7 cases) | Plain, spaces, diacritics, emojis, fallback, collapse, trim |
| Index I/O (`loadGroupIndex`/`saveGroupIndex`) | Yes (4 cases) | Missing, malformed, roundtrip, no tmp leftover |
| `ensureGroupFolder` | Yes (4 cases) | New, cached, 2-collision, 3-collision |
| `persistMessage` + `readDayMessages` | Yes (6 cases) | Single, multiple, different days, malformed skip, permission error, missing file |
| `listDays` | Yes (3 cases) | Empty folder, missing folder, 3 files desc |
| `findGroupsByName` | Yes (4 cases) | Empty index, exact, fuzzy, no match, plus sort-desc |
| `localDate` | Partial | Format only — does NOT verify local vs UTC behavior in a TZ-sensitive way |
| `parseDateSpec` | Yes (7 cases) | today, undefined, empty, yesterday, Nd, ISO, invalid |
| `cmdSummary` | Yes (9 cases) | No args, no match, ambiguous, empty day, happy path, yesterday, Nd, ISO date, claude error |
| Persist hook in `src/index.ts` | No (explicit out-of-scope per task-02 note) | Would require a whatsapp-web.js mock |

**Test Coverage Assessment**: Thorough. The one weak spot is
`localDate` — its test does not catch a regression where the function
accidentally returns the UTC date. Happy path `cmdSummary` test passes
against a stub that ignores the prompt, so it verifies the wiring but
not the prompt construction. Both are Important-level fixes, not
blockers.

## Test Execution

| Check | Result | Details |
|-------|--------|---------|
| Test command discovered | Yes (`npm test`) | `package.json` `scripts.test` = `vitest run` |
| Test suite run | Passed (248/248) | 13 test files, ~700ms |
| TDD evidence in implementation notes | N/A | `implementation-notes.md` not present |

One unrelated unhandled rejection from `src/index.test.ts` — it imports
`./index` which auto-runs `main()` at module load (tries to create a
Puppeteer browser). Pre-existing; not introduced by these changes.
Doesn't affect test results — 248/248 still pass.

**Test Execution Assessment**: Clean run, all green, tsc clean.

## TDD Compliance

| Task | Tests Written | Tests Adequate | TDD Skipped Reason Valid | Notes |
|------|---------------|---------------|-------------------------|-------|
| task-01-groups-persistence | Yes (29 cases in `groups.test.ts`) | Yes (28/29 meaningful) | N/A | `localDate` test is weak — see Important issue above |
| task-02-summary-integration | Yes (16 new cases in `commands.test.ts`: 7 `parseDateSpec` + 9 `cmdSummary`) | Yes (15/16 meaningful) | N/A | `!summary` happy path verifies reply but not prompt construction — see Important issue |

**TDD Assessment**: Tests cover the acceptance criteria comprehensively.
Mocking discipline is good: no fs mocks (real temp dirs via
`mkdtempSync` + `process.chdir`), no mocks of modules under test. The
single use of `vi.spyOn(fs, 'appendFileSync')` is specifically to
simulate a permission error — that's the boundary being exercised, so
it's fine.

**Test Adequacy**: 43/45 tests are meaningful and specific. 2 flagged
as weak (listed under Important): `localDate` format-only assertion,
and `cmdSummary` happy path that doesn't verify prompt contents.

## Implementation Decision Review

| Task | Decisions Documented | Decisions Sound | Flags |
|------|---------------------|----------------|-------|
| task-01 | No (no implementation-notes.md) | Mostly yes | Non-obvious: reuse `normalize()` + second ASCII pass; `toLocaleDateString('en-CA')` choice; counter loop starting at 2 |
| task-02 | No | Mostly yes | SYSTEM_TYPES superset (`revoked`/`call_log` beyond spec); `SYSTEM_TYPES` allocated per-message |

**Decision Assessment**: The engineering decisions are all reasonable
and follow the codebase's existing conventions (atomic writes, cwd-
relative paths, pure helpers with tests in the same file). The absence
of `implementation-notes.md` is a Minor issue — not blocking, but a
future reviewer would benefit from a note on the SYSTEM_TYPES superset
and the slugify dual-pass strategy.

## Recommendations

1. **Fix `from_jid` for Nick's own messages** (`src/index.ts:209-213`):
   when `msg.fromMe`, set `fromJid = ownerCusId` explicitly.
2. **Escape `$` runs in `fillTemplate` values** (`src/prompts.ts:227`):
   either `vars[key].replace(/\$/g, '$$$$')` or use the function-
   replacement form. This prevents user-generated content in message
   bodies from silently mangling summary prompts.
3. **Strengthen the `localDate` test** with a near-midnight-UTC
   timestamp that flips days under at least one plausible local TZ.
4. **Strengthen the `!summary` happy-path test** to verify prompt
   construction (capture stdin that the stub claude receives; assert
   the message lines and `(me)` suffix are present).
5. **Move `SYSTEM_TYPES` to module scope** in `src/index.ts`.
6. **Add a short `tasks/main/implementation-notes.md`** documenting
   the SYSTEM_TYPES superset, the slugify dual-pass, and the
   `toLocaleDateString('en-CA')` choice.
7. (Optional) Cap `findGroupsByName` results to some sane number
   (10?) to bound the "multi match" reply length.
