# Refactor Plan: Security Vulnerability Fixes

## Summary

This plan addresses 6 of the 12 findings from the security audit of the me-claude repository. Six findings were explicitly deferred by the user after the discovery pass. All tasks are behavior-preserving for normal operation; the changes restrict what an adversarial input can do, not what the bot does in normal use.

---

## In-Scope Findings

### V-001 + V-004 (task-01) — Subprocess cwd + Prompt Injection

**What was found:**
`callClaudeWithTools` in `src/claude.ts:74-87` defaults `cwd` to `process.cwd()` (the project root). `src/index.ts:472` calls it without a `cwd` argument, so the Claude subprocess inherits the project root and can Read, Edit, Write, Grep, and Glob any file under it — including `.env` (API keys), `data/session/` (WhatsApp auth tokens), and all source files.

Separately, `src/prompts.ts:59-171` interpolates `{SENDER_NAME}`, `{BEFORE_MESSAGES}`, `{AFTER_MESSAGES}`, `{MENTION_MESSAGE}` into the RUNTIME_PROMPT without structural delimiters, and without stripping newlines or markdown-heading characters from pushnames.

**Strategy:**
- Create `src/sandbox.ts` with `createSandbox()` / `destroySandbox()` / `sanitizePushname()`
- Sandbox exposes only `data/contacts/` (symlink), `data/groups/` (symlink), and `voice_profile.md` (symlink) — nothing from project root
- `src/index.ts` builds the sandbox before each `callClaudeWithTools` call and destroys it in a `try/finally`
- `src/prompts.ts` wraps all four user-controlled blocks with XML-style `<tag>...</tag>` delimiters
- `sanitizePushname` strips `\r`, `\n`, backtick, leading `#`; caps at 64 chars
- V-002 `TODO(memory-guard)` comment updated to say "intentionally deferred — see security-refactor notes (task-01)"

**Why `data/contacts/` is a symlink (not a restricted copy):**
The user explicitly kept the cross-contact Grep instruction (V-008 answer: keep as-is). Claude's Write/Edit tools resolve through symlinks, so contact memory updates land in the real `data/contacts/` tree. The sandbox isolates `.env`, `data/session/`, `src/`, `node_modules/` — the high-value targets — while preserving Claude's ability to do cross-contact lookups.

### V-009 (task-02) — Group Slug Uniqueness

**What was found:**
`src/groups.ts:134-159` `ensureGroupFolder` uses a text-slug counter (`-2`, `-3`, ...) for collision avoidance. The counter only prevents two *live, indexed* JIDs from having the same folder. Two groups with the same name registered from different bot instances or after an index wipe could get the same slug. Additionally, the GROUP_FOLDER variable in RUNTIME_PROMPT references the folder name, so if the wrong folder is referenced, Claude could grep the wrong group's archive.

**Strategy:**
Append 6 hex characters of `sha256(chatJid)` to the base slug at registration time. Existing entries in `.index.json` are untouched (the `if (idx[chatJid]) return idx[chatJid].folder` early-return handles backwards compatibility). The counter fallback is preserved as a last resort.

### V-010 (task-03) — RegExp Key Injection in fillTemplate

**What was found:**
`src/prompts.ts:242` constructs `new RegExp(`\\{${key}\\}`, 'g')`. Template keys are currently safe uppercase strings, but if a caller ever passed a key with regex metacharacters (`[`, `(`, `.`, etc.), this would throw a `SyntaxError` or produce wrong matches.

**Strategy:**
Replace `new RegExp` + `String.prototype.replace` with `String.prototype.split(literal).join(value)`. This is immune to metacharacter injection and also eliminates the `$`-in-replacement-string escaping workaround (split/join treats the replacement value literally).

### V-011 (task-04) — Topic Bank Overflow + Config Schema Guard

**What was found:**
`src/commands.ts:459-513` `cmdTopic` has no length cap on `!topic add` phrases and no count cap on `cfg.explicitTopics`. `src/ambient.ts:40-53` `loadAmbientConfig` casts the parsed JSON directly to `AmbientConfig` with no validation — a hand-edited or corrupted config silently loads with wrong types.

**Strategy:**
- In `cmdTopic`: reject phrases > 64 chars; reject adds when `explicitTopics.length >= 200`
- In `loadAmbientConfig`: add `isValidAmbientConfig` type guard that checks every field type; if validation fails, log a warning and return `defaultAmbientConfig()`

No new dependencies added.

### V-012 (task-05) — Predictable Atomic Write Tmp File Names

**What was found:**
Four atomic write sites use `${process.pid}-${Date.now()}` as the tmp file suffix: `src/memory.ts:43`, `src/ambient.ts:58`, `src/memory-guard.ts:44`, `src/groups.ts:118`. These are predictable for any process that knows the bot's PID and can time writes.

**Strategy:**
Replace with `crypto.randomBytes(8).toString('hex')`. Add `O_EXCL | O_CREAT` on the `openSync` call to guarantee the tmp path didn't exist. Extract a shared `src/atomic.ts` utility to avoid repeating the pattern in four files.

---

## Explicitly Out-of-Scope Findings

| Finding | Reason skipped |
|---------|----------------|
| **V-002** — runtime memory writes bypass memory-guard | Deferred. The sandbox cwd (task-01) limits blast radius. The TODO comment is updated to say "intentionally deferred — see security-refactor notes (task-01)". |
| **V-003** — path traversal in `!forget` / `!remember` / `!who` | Skipped. The owner-only gate makes exploitation require account compromise. The `.md` suffix limits reachable targets. |
| **V-005** — `data/session/` relocation | Skipped. The sandbox cwd (task-01) makes `data/session/` unreachable from the Claude subprocess. Relocation is belt-and-suspenders. |
| **V-006** — unpinned dependencies / no lockfile | Skipped. Acceptable risk for a personal bot. |
| **V-007** — per-group-only rate limiter | Skipped. Acceptable for current threat model. |
| **V-008** — cross-contact Grep instruction in RUNTIME_PROMPT | Kept by explicit user decision. This is a desired feature. |

---

## Task Ordering and Dependencies

```
task-01 (sandbox + input fencing)
  — V-001 + V-004; creates src/sandbox.ts; changes src/index.ts, src/prompts.ts, src/claude.ts
  — stands alone; no dependency on other tasks

task-02 (slug jid hash)
  — V-009; changes src/groups.ts only
  — independent of task-01; can run in parallel

task-03 (fillTemplate safe replace)
  — V-010; changes src/prompts.ts only (the fillTemplate function)
  — independent; can run in parallel with task-01 and task-02
  — NOTE: task-01 also touches src/prompts.ts (RUNTIME_PROMPT constant). If task-01 and
    task-03 are applied concurrently, merge carefully — they edit different parts of the file

task-04 (topic validation + schema guard)
  — V-011; changes src/commands.ts and src/ambient.ts
  — independent; can run in parallel with all other tasks

task-05 (tmp file random naming)
  — V-012; changes src/memory.ts, src/ambient.ts, src/memory-guard.ts, src/groups.ts;
    creates src/atomic.ts
  — independent; NOTE: task-04 also touches src/ambient.ts. Apply task-04 first OR
    merge carefully if running in parallel
```

**Safe parallel execution order:**

1. Run task-01 first (largest change, affects three files)
2. Run task-02, task-03, task-04, task-05 in parallel after task-01 completes
   — exception: task-03 touches `src/prompts.ts` (also touched by task-01); confirm task-01 is merged before starting task-03
   — exception: task-04 and task-05 both touch `src/ambient.ts`; apply one then the other

---

## Test Commands

```bash
npm test          # runs vitest; all tests should pass after each task
npm run typecheck # tsc --noEmit; no new type errors should be introduced
```

---

## Risk Notes for Implementers

1. **Sandbox symlink behavior:** On Linux and macOS, `fs.symlinkSync(target, linkPath)` creates a soft symlink. The Claude subprocess sees `data/contacts/` as a normal directory. Writes by Claude go to the real `data/contacts/`. After `destroySandbox`, those writes persist. This is correct.

2. **Sandbox cleanup on process crash:** `destroySandbox` is called in `try/finally`, but if the Node process is killed (SIGKILL), the sandbox directory in `/tmp` will be left behind. This is acceptable — OS tmp cleanup or a startup sweep can handle it. Do not add a SIGKILL handler for this.

3. **task-01 and task-03 both edit src/prompts.ts:** task-01 modifies `RUNTIME_PROMPT` (adding XML delimiters); task-03 modifies `fillTemplate` (the function, not the constants). They are in different parts of the file and can be applied sequentially without conflict. Apply task-01 first.

4. **task-04 and task-05 both edit src/ambient.ts:** task-04 modifies `cmdTopic` (in `src/commands.ts`) and `loadAmbientConfig` (in `src/ambient.ts`); task-05 modifies `saveAmbientConfig` (in `src/ambient.ts`). These are different functions. Apply one then the other; no conflict.

5. **`O_NOFOLLOW` availability (task-05):** Use `fs.constants.O_NOFOLLOW ?? 0` to avoid a ReferenceError on platforms where the constant is not defined.
