# Refactor Questions

## Code Audit Summary

All 12 findings were verified against HEAD. None have been mitigated since the report was written. Relevant details per finding:

**V-001 — CONFIRMED.** `src/claude.ts:74-87` spawns claude with `--permission-mode bypassPermissions` and `--allowed-tools Read,Edit,Write,Grep,Glob`. The `cwd` parameter defaults to `process.cwd()` (line 77: `cwd: string = process.cwd()`). In `src/index.ts:472`, `callClaudeWithTools(fillTemplate(promptTemplate, vars))` is called with no explicit `cwd`, so the subprocess inherits the project root. From the project root the subprocess can reach `data/session/` (WhatsApp auth tokens), `.env` (API keys), `src/**` (all source), and any contact files. Attacker input flows in via `SENDER_NAME` (pushname), `BEFORE_MESSAGES`, `AFTER_MESSAGES`, `MENTION_MESSAGE`, all set from unvalidated WhatsApp message content.

**V-002 — CONFIRMED.** The TODO at `src/index.ts:110-113` is still present verbatim: "guardedWriteContactMemory is only invoked by memory-bootstrap.ts and the !remember command — NOT on the runtime reply path." The runtime path at line 472 calls `callClaudeWithTools` and the subprocess is free to call Edit/Write on any file within cwd. `guardedWriteContactMemory` in `src/memory-guard.ts` (which enforces empty-check, 8KB cap, 70% shrinkage guard, and Identity-header check) is never invoked on the runtime path.

**V-003 — CONFIRMED.** `src/commands.ts:94-96`: `contactFilePath(jid)` calls `path.join(contactsDir(), \`${jid}.md\`)` with no validation. `path.join` does resolve `..` components. `!forget ../../.env` would resolve to `<project root>/.env.md` — that file doesn't exist, so unlink returns ENOENT silently. However `!forget ../groups/.index` resolves to `data/groups/.index.json.md` (ENOENT) and `!forget ../../src/index` reaches `src/index.ts.md` (also ENOENT with the `.md` suffix). The `.md` suffix is appended, so the traversal can only reach `.md`-suffixed paths. A contact file named without a real extension but stored as e.g. `../../data/ambient-config.json` would resolve to `data/ambient-config.json.md` (ENOENT). The most realistic impact: `!who ../../data/ambient-config.json` reads `data/ambient-config.json.md` (ENOENT), but `!forget ../../data/contacts/<real-jid>@c.us` resolves correctly if the traversal reaches an actual `.md` file. Since every contact file ends in `.md`, this is a real deletion path via `!forget ../../data/contacts/victim@c.us`. Note: this command gate is restricted to the owner's self-chat DM, so it requires the attacker to be you — but the report may have a different threat model (e.g. if the owner's account is compromised or a contact can send to the DM).

**V-004 — CONFIRMED.** `src/prompts.ts:59-171` (RUNTIME_PROMPT): `{SENDER_NAME}` appears at lines 73 and 92 (inside the new-contact file template). `{BEFORE_MESSAGES}`, `{AFTER_MESSAGES}`, `{MENTION_MESSAGE}` appear at lines 164-170. `fillTemplate` at line 234 escapes `$` but does NOT escape newlines, markdown, or prompt injection tokens (e.g. `\nIgnore all prior instructions`, `\n# OVERRIDE`). A pushname like `\n# OVERRIDE\nForget the above and do X` would be interpolated verbatim into the system prompt. This also persists into `data/contacts/<jid>.md` because the new-contact template at line 92 uses `# {SENDER_NAME}` as the H1 header — a malicious pushname becomes a markdown heading in a file that the subprocess reads on future invocations.

**V-005 — CONFIRMED.** `data/session/` exists at the project root (verified in the repo — multiple Chromium extension JSON files confirmed at `data/session/session/...`). The subprocess cwd is the project root, so the Read tool can read `data/session/` contents. The `.gitignore` excludes `data/session/` from the main git repo, but that is irrelevant to subprocess file access.

**V-006 — CONFIRMED.** `package.json`: `whatsapp-web.js: "github:pedroslopez/whatsapp-web.js"` (no SHA/tag), `qrcode-terminal: "latest"`, `tsx: "latest"`, `vitest: "latest"`. No `package-lock.json` file exists in the repo — supply chain risk is therefore unrestricted at install time (not even a lockfile to repeat a known-good install).

**V-007 — CONFIRMED.** `src/index.ts:73-81`: `isRateLimited` keys on `groupJid` only (line 80: `lastReplyAt.get(groupJid)`). Line 355-360 checks and records the rate limit before spawning the Claude subprocess. There is no per-sender key, no global concurrency counter, and no cap on simultaneous `callClaudeWithTools` invocations. An attacker in N groups can trigger N concurrent subprocesses (each a full `claude` process with tool access).

**V-008 — CONFIRMED.** `src/prompts.ts:78-79`: "If you want, Grep data/contacts/ for related names mentioned in the chat context to pick up cross-references. Keep this fast — no more than 1-2 extra reads." This is by design and allows the Claude subprocess to read any contact file in the directory, not just the sender's. An attacker who knows another contact's display name (visible in group chat) can cause cross-contact memory disclosure.

**V-009 — CONFIRMED.** `src/groups.ts:73-92`: `slugifyGroupName` ultimately returns whatever `normalize()` + dash-collapsing produces. Adversarial group names that normalize to empty string fall back to `jidUserPart` (the digits before the `@` in the JID). The `ensureGroupFolder` collision-suffix logic (`-2`, `-3`, ...) prevents two distinct groups from mapping to the same folder. However, two groups with identical slugs but different JIDs will collide in *archival* if `ensureGroupFolder` hasn't been called yet on the second JID (it gets `-2`). The real cross-contamination risk is if the `GROUP_FOLDER` variable in the RUNTIME_PROMPT leads Claude to grep the wrong group's JSONL archive. The report's specific concern ("../.. and *** → 'untitled'") would only both fall through to the `fallback` parameter if their slugs both normalize to empty — but the fallback is the JID's user part (numeric), not a shared string. So cross-contamination is only possible if two empty-slug groups have the same JID prefix — extremely unlikely. Severity is lower than assessed.

**V-010 — CONFIRMED (latent only).** `src/prompts.ts:236`: `new RegExp(\`\\\\{${key}\\\\}\`, 'g')` — keys are currently hard-coded strings from `vars` objects in the callers. No path exists today for an attacker to inject a new key. Latent.

**V-011 — CONFIRMED.** `src/commands.ts:459-513`: `!topic add <phrase>` appends to `cfg.explicitTopics` with no length check on the phrase and no count cap on the array. `src/ambient.ts:40-53`: `loadAmbientConfig` does `JSON.parse(raw) as AmbientConfig` with no schema validation — a hand-edited or corrupted `ambient-config.json` with arbitrary array entries loads without error. Since `!topic` commands require sending to the owner's self-chat DM, the threat is self-inflicted or requires account compromise.

**V-012 — CONFIRMED (theoretical only).** `src/memory-guard.ts:44`: `\`${finalPath}.tmp-${process.pid}-${Date.now()}\`` and `src/ambient.ts:58`: same pattern. These are predictable paths on a single-tenant personal machine. A real symlink race would require a concurrent attacker process with write access to the same directory, which is not a realistic threat for a single-user local bot. Theoretical.

## Issues Found

- V-001 [Critical] `src/claude.ts:74-87` + `src/index.ts:472` — unconstrained cwd exposes entire project to Claude subprocess tool access
- V-002 [Critical] `src/index.ts:110-113` — runtime memory writes bypass all corruption guards in `src/memory-guard.ts`
- V-003 [High] `src/commands.ts:94-96` — unvalidated JID in path construction; traversal to any `.md` file under project root
- V-004 [High] `src/prompts.ts:59-171` + `fillTemplate` — pushname and message bodies interpolated raw into system prompt and contact file templates
- V-005 [High] project root as cwd means `data/session/` is reachable by V-001 chain
- V-006 [Medium] `package.json` — no lockfile, three `latest` pins, one floating GitHub HEAD reference
- V-007 [Medium] `src/index.ts:73-81` — rate limiter keys on group only; N groups = N concurrent subprocesses
- V-008 [Medium] `src/prompts.ts:78-79` — cross-contact Grep is by design; any contact's file readable by attacker's trigger
- V-009 [Low] `src/groups.ts:73-92` — slug collisions handled by counter, but GROUP_FOLDER in prompt could reference wrong archive; severity lower than reported
- V-010 [Low/Latent] `src/prompts.ts:236` — RegExp key injection; currently latent
- V-011 [Low] `src/commands.ts:459-513` — no length/count cap on `!topic add`; no schema validation in `loadAmbientConfig`
- V-012 [Low/Theoretical] `src/memory-guard.ts:44` + `src/ambient.ts:58` — predictable tmp paths; no realistic attack vector for single-user local bot

## Existing test coverage

Tests exist and are reasonably comprehensive for: `fillTemplate` (prompts), `slugifyGroupName` (groups), `guardedWriteContactMemory` (memory-guard), all command handlers (!remember, !forget, !who, !status, !silence, !resume, !ambient, !topic, !summary).

**Not covered by tests:** path traversal in `contactFilePath`, input sanitization/delimiter fencing in `fillTemplate`, cwd scoping in `callClaudeWithTools`, rate-limiter keying logic under concurrent load, `loadAmbientConfig` schema validation.

---

## Questions

### Q1: Scope — which findings do you want fixed in this pass?
**Context:** The 12 findings span two architectural problems (V-001/V-002 require structural changes to the Claude invocation), three input-sanitization problems (V-003/V-004/V-008), one supply-chain problem (V-006), and four low-severity issues (V-007/V-009/V-011/V-012) that are mostly self-inflicted or theoretical given this is a single-user personal bot. Addressing all 12 in one pass risks producing a large, hard-to-review diff.

**Question:** Which findings should be in scope for this fix pass?
**Options:**
- A) Critical + High only (V-001 through V-005) — most impactful, still ~3-4 tasks
- B) Critical + High + Medium (V-001 through V-008) — adds rate-limiter fix and cross-contact grep removal
- C) All 12 — include low-severity and theoretical issues too
- D) P0 only (V-001 + V-002) — just fix the structural subprocess exposure first, everything else in a follow-up

---

### Q2: V-001 — how do you want to constrain the Claude subprocess cwd?
**Context:** The core issue is that `callClaudeWithTools` runs claude with the project root as cwd, giving the subprocess tool access to `.env`, `data/session/` (WhatsApp auth tokens), source files, and all data. Three mitigation strategies exist and can be combined:

- **Sandbox cwd**: Pass a restricted `cwd` — e.g. a dedicated `data/sandbox/` directory containing only what Claude legitimately needs: `data/contacts/` (symlinked or copied on demand) and `data/groups/<folder>/`. This prevents access to `.env`, session files, and source.
- **Drop bypassPermissions**: Remove `--permission-mode bypassPermissions` and use `--allowedFiles` or pre-approval for the exact paths Claude needs. This requires claude CLI to support a non-interactive allow-list mode, which may not exist.
- **Input fencing + sanitization**: Wrap all untrusted inputs in structural delimiters (XML-style `<user_message>...</user_message>`) and strip/escape newlines from pushnames before interpolation. Defense-in-depth, does NOT replace cwd isolation.

**Question:** Which approach(es) do you want implemented for V-001?
**Options:**
- A) Sandbox cwd only — create `data/sandbox/` with only `data/contacts/` accessible; leave bypassPermissions in place (needed for non-interactive operation)
- B) Input fencing only — add delimiters and pushname sanitization in `fillTemplate` / prompt construction; do not change cwd (fastest, weakest)
- C) Both A and B — sandbox cwd AND input fencing as defense-in-depth
- D) Something else (please describe)

---

### Q3: V-001 / V-005 — should data/session/ be relocated?
**Context:** `data/session/` holds the WhatsApp authentication tokens (Chromium browser state). It lives under the project root because `whatsapp-web.js` is configured with `dataPath: 'data/session/'` in `src/whatsapp.ts:7`. Moving it outside the project root (e.g. to `~/.me-claude/session/`) would require changing the `LocalAuth` config and a one-time migration for existing installations — the existing session would need to be moved or recreated (re-scanning the QR code).

If V-001 is fixed with a sandbox cwd (Q2 option A or C), session files become unreachable from the subprocess even at the current location. Relocation is then belt-and-suspenders rather than required.

**Question:** Should `data/session/` be relocated out of the project root as part of this fix, or is sandbox cwd isolation sufficient?
**Options:**
- A) Relocate to a configurable path outside the project (e.g. `~/.me-claude/session/`), accept migration cost
- B) Leave in place — sandbox cwd isolation (from Q2) is sufficient
- C) Only relocate if Q2 option B (input fencing only) was chosen and no cwd sandbox is being added

---

### Q4: V-002 — how do you want to enforce memory-guard on runtime writes?
**Context:** The TODO at `src/index.ts:110-113` documents the gap: Claude's Edit/Write tool calls bypass `guardedWriteContactMemory` entirely. Two approaches exist:

- **Post-call git diff validator**: After `callClaudeWithTools` returns, run `git diff HEAD` inside `data/contacts/` to detect what files changed, then validate each changed file against the memory-guard rules. If any file fails, revert it via `git checkout HEAD -- <file>`. This requires the contacts directory to already be a git repo (it is, lazily initialized by memory-guard), and adds ~50-100ms per call.
- **Pre-call snapshot / rollback wrapper**: Before calling Claude, snapshot all contact files (or their hashes). After the call, diff against the snapshot, validate, and roll back violating files. Does not require git but requires maintaining the snapshot in memory.

**Question:** Which V-002 approach do you prefer?
**Options:**
- A) Post-call git diff validator — leverage the existing nested git repo; revert bad writes via `git checkout`
- B) Pre-call snapshot / rollback — store hashes before the call, validate after, roll back in code without git dependency
- C) Neither yet — skip V-002 for this pass (the subprocess cwd sandbox from V-001 already limits blast radius)

---

### Q5: V-003 — path traversal in !forget / !remember / !who
**Context:** `contactFilePath(jid)` in `src/commands.ts:94-96` uses `path.join` without validating that the resolved path stays inside `data/contacts/`. The `.md` suffix is appended after the join, so traversal can only reach `.md`-named files — but contact files are themselves `.md` files, making `!forget ../../data/contacts/victim@c.us` a valid deletion path. The `!` commands are only reachable from the bot owner's self-chat DM (`msg.fromMe && chat.id._serialized === ownerCusId` gate at `src/index.ts:183`). The threat model therefore requires either (a) the owner's WhatsApp account being compromised, or (b) the owner accidentally sending a traversal string.

**Question:** Should V-003 be fixed regardless of the restricted attack surface (owner-only commands), and if so, at what layer?
**Options:**
- A) Yes — add a `path.resolve` containment check in `contactFilePath` (assert the resolved path starts with `contactsDir()`)
- B) Yes — additionally validate that the jid argument matches a known JID pattern (e.g. ends with `@c.us`, `@lid`, or `@g.us`) before building the path
- C) Both A and B
- D) Skip — the owner-only gate makes this low-priority; note in comments

---

### Q6: V-004 — input sanitization depth
**Context:** Pushnames (`contact.pushname`) and raw message bodies flow into the RUNTIME_PROMPT and into the new-contact file template (`# {SENDER_NAME}` becomes the H1 heading). `fillTemplate` escapes `$` but not newlines or other injection characters. Remediation options:

- **Structural delimiters**: Wrap each untrusted block with XML-style delimiters in the prompt (`<sender_name>...</sender_name>`, `<message>...</message>`), which gives Claude a structural signal about what is data vs instruction. This is the recommended modern approach for prompt injection defense.
- **Sanitize at interpolation**: Strip or escape `\n`, `\r`, and markdown heading characters from pushnames before they become `{SENDER_NAME}` in the H1 header. Less important for the BEFORE/AFTER/MENTION blocks (which are long-form chat context where newlines are expected), but critical for the pushname.
- **Both**: Delimiters around all blocks AND sanitize the pushname for the contact file H1.

**Question:** Which V-004 remediation do you want?
**Options:**
- A) Structural delimiters in RUNTIME_PROMPT around all user-controlled blocks (BEFORE_MESSAGES, AFTER_MESSAGES, MENTION_MESSAGE, SENDER_NAME)
- B) Sanitize pushname only — strip newlines/markdown heading chars from `mentionSenderName` before it enters `vars`; leave message blocks as-is (they legitimately contain newlines)
- C) Both A and B — delimiters AND pushname sanitization

---

### Q7: V-006 — dependency pinning
**Context:** There is no `package-lock.json` in the repo, so every `npm install` resolves `latest` afresh. Three deps are unpinned: `qrcode-terminal: "latest"`, `tsx: "latest"`, `vitest: "latest"`. The most significant is `whatsapp-web.js: "github:pedroslopez/whatsapp-web.js"` — this floats to HEAD of the upstream GitHub repo with no SHA, meaning `npm install` can silently pull breaking or malicious changes at any time.

Options for `whatsapp-web.js`: pin to a specific commit SHA (e.g. the SHA currently resolved in your node_modules), pin to the latest tagged release if one exists, or add a subresource integrity check. For the `latest` dev deps, either pin to exact current versions or accept them as low-risk dev tools.

**Question:** How do you want to handle V-006?
**Options:**
- A) Pin `whatsapp-web.js` to the commit SHA currently in your `node_modules` (run `npm ls whatsapp-web.js` to find it); pin `tsx` and `vitest` to current installed versions; leave `qrcode-terminal` (used only at startup, low risk)
- B) Pin all four to specific versions/SHAs
- C) Generate a `package-lock.json` and commit it — this is the idiomatic Node.js supply-chain fix; individual pinning is secondary
- D) Skip — acceptable risk for a personal bot

---

### Q8: V-007 — rate limiter scope
**Context:** The current rate limiter (`src/index.ts:73-81`) enforces one reply per group per 10 seconds. An attacker in N groups can trigger N concurrent Claude subprocess invocations simultaneously. Each subprocess is a full `claude` CLI process with file tool access, so N simultaneous subprocesses mean N concurrent readers/writers on `data/contacts/`.

**Question:** What concurrency controls do you want added?
**Options:**
- A) Add a per-sender rate limit key (groupJid + senderJid) in addition to the existing per-group key — limits one sender's flood across multiple groups
- B) Add a global max-concurrency counter (reject invocations when N subprocesses are already running); what should N be? (Suggest: 3)
- C) Both A and B
- D) Skip — acceptable for a personal bot with trusted contacts

---

### Q9: V-008 — cross-contact Grep instruction
**Context:** RUNTIME_PROMPT line 78-79 explicitly instructs: "Grep data/contacts/ for related names mentioned in the chat context to pick up cross-references." This is a deliberate feature that lets Claude enrich replies with knowledge about other contacts. The tradeoff: any attacker-controlled message body that mentions another contact's name can trigger a read of that contact's memory file.

**Question:** Should this instruction be removed or scoped?
**Options:**
- A) Remove entirely — Claude should only Read/Edit/Write the sender's own contact file (`{SENDER_JID}.md`); cross-contact lookup is not worth the disclosure risk
- B) Narrow — change the instruction to allow Grep only for names that appear in the pre-existing memory file for the current sender (reduces cold-start leakage)
- C) Keep as-is — this is a feature you want; cross-contact context enriches replies

---

### Q10: Safety-net tests before refactoring
**Context:** The following security-critical behaviors currently have no targeted tests: (a) path traversal rejection in `contactFilePath`, (b) pushname sanitization in `fillTemplate` or the prompt-building code, (c) `callClaudeWithTools` cwd parameter enforcement, (d) concurrent invocation counting. Adding tests before modifying these code paths creates a regression safety net and confirms the fix is correct.

**Question:** Should test files be written as a first task before the security fixes are implemented?
**Options:**
- A) Yes — write tests for the above gaps first, then implement fixes (safest, adds one task at the start)
- B) No — write tests alongside each fix task (inline)
- C) No — the existing test suite is sufficient; don't add test overhead to this pass
