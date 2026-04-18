# Task 02: Ambient commands + runtime integration + voice profile extraction

## Objective

Wire the ambient infrastructure from Task 01 into the bot: add `!ambient`
and `!topic` command handlers, integrate the ambient path into
`src/index.ts`, add a voice-profile topic extractor using claude, and
document the feature in the README.

## Target Files

- `src/commands.ts` (add `!ambient` and `!topic` handlers)
- `src/commands.test.ts` (tests for new commands)
- `src/index.ts` (add ambient path in the handler)
- `src/ambient.ts` (add `extractVoiceProfileTopics` function)
- `src/ambient.test.ts` (tests for the extractor — mock claude subprocess)
- `README.md` (add Ambient section)

## Context Files

- `tasks/main/shared-context.md`
- `tasks/main/task-01-ambient-infra.md` — the contract you're building on
- `src/commands.ts` — current dispatcher structure and existing commands
- `src/index.ts` — current handler gates (group, fromMe, mention/reply, rate limit)
- `src/claude.ts` — `callClaude` (no-tools) for the voice profile extraction
- `src/prompts.ts` — `VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT`, `AMBIENT_PROMPT_PREFIX`

## Dependencies

**Depends on Task 01** — all the exports from `src/ambient.ts`, `src/fuzzy.ts`,
`AMBIENT_PROMPT_PREFIX`, `VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT`, and new
`EventKind` values must exist before this task starts.

## Requirements

### 1. `src/ambient.ts` — add `extractVoiceProfileTopics`

```typescript
// Call claude (no tools) with VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT to
// extract topic keywords. Parse newline-separated output, trim, lowercase,
// filter empty lines, deduplicate. Returns up to 20 topics.
// If the voice profile file is missing, returns [].
// On claude failure, returns [] and logs a warning (never throws).
export async function extractVoiceProfileTopics(voiceProfilePath?: string): Promise<string[]>;
```

Where `voiceProfilePath` defaults to `path.join(process.cwd(), 'data', 'voice_profile.md')`.

Also add a convenience:

```typescript
// Refreshes voiceProfileTopics in the config if the voice profile's mtime
// has changed since last extraction. No-op otherwise. Saves the config.
export async function maybeRefreshVoiceProfileTopics(): Promise<{ refreshed: boolean; count: number }>;
```

### 2. `src/commands.ts` — new commands

Add to the dispatcher's switch/table:

**`!ambient` family** (all modify `ambient-config.json` and reply confirming):

| Syntax | Effect |
|---|---|
| `!ambient on` | `masterEnabled = true`, reply `ok, ambient on. applies to all groups except: <disabledGroups list or "none">` |
| `!ambient off` | `masterEnabled = false`, reply `ok, ambient off globally` |
| `!ambient on <chat>` | remove `<chat>` (normalized) from `disabledGroups`, reply `ok, re-enabled ambient in <chat>` |
| `!ambient off <chat>` | add `<chat>` (normalized) to `disabledGroups` if not already there, reply `ok, disabled ambient in <chat>` |
| `!ambient status` | reply with: master state, disabledGroups, cap, threshold, repliesToday count, topicBank size |
| `!ambient cap <n>` | set `dailyCap = n` (validate: positive int), reply `ok, daily cap set to <n>` |
| `!ambient threshold <n>` | set `confidenceThreshold = n` (validate 0–1), reply `ok, threshold set to <n>` |
| `!ambient refresh` | call `maybeRefreshVoiceProfileTopics()` AND rebuild memoryTopics; reply `ok, refreshed: voice=<n> memory=<m>` |

**`!topic` family**:

| Syntax | Effect |
|---|---|
| `!topic add <phrase>` | add normalized phrase to `explicitTopics` (dedupe), reply `ok, added <phrase>. total: <n>` |
| `!topic remove <phrase>` | remove (normalized) from `explicitTopics`, reply `ok, removed <phrase>` or `not in list` |
| `!topic list` | reply with all topics: explicit (list), voice (list), memory (list) — each as a separate section |

Every `!ambient` and `!topic` handler that modifies config MUST:
1. `ensureDailyReset(cfg)` before reading state
2. Save the modified config via `saveAmbientConfig`

`!help` text should list the new commands.

### 3. `src/index.ts` — integrate ambient path

After the existing `if (!trigger) return` skip in the `message_create`
handler, add the ambient path BEFORE that return. The logic:

```typescript
if (!trigger) {
  // No mention, no reply-to-Nick. Try ambient.
  let ambientDecision: AmbientDecision | null = null;
  try {
    const cfg = ensureDailyReset(loadAmbientConfig());
    const topicBank = buildTopicBank(cfg, loadMemoryTopics());
    ambientDecision = shouldAmbientReply({
      cfg, chatName: chat.name, messageBody: msg.body || '', topicBank
    });
  } catch (e) {
    dbg(`ambient gate threw: ${(e as Error).message}`);
  }

  if (!ambientDecision || !ambientDecision.pass) {
    dbg(`ambient skip: ${ambientDecision?.reason ?? 'gate error'}`);
    logEvent({
      kind: 'ambient.skipped',
      chat: chat.name,
      chat_id: chat.id._serialized,
      reason: ambientDecision?.reason ?? 'gate error',
    });
    return;
  }

  // Ambient triggered
  trigger = 'ambient' as any; // extend the union locally; or change the type
  dbg(`ambient triggered: matchedTopic=${ambientDecision.matchedTopic} score=${ambientDecision.score}`);
  logEvent({
    kind: 'ambient.considered',
    chat: chat.name,
    chat_id: chat.id._serialized,
    matchedTopic: ambientDecision.matchedTopic,
    score: ambientDecision.score,
  });
}
```

Then, when building the prompt, if `trigger === 'ambient'` prepend
`AMBIENT_PROMPT_PREFIX` to `RUNTIME_PROMPT`:

```typescript
const promptTemplate = trigger === 'ambient'
  ? (AMBIENT_PROMPT_PREFIX + RUNTIME_PROMPT)
  : RUNTIME_PROMPT;
const response = await callClaudeWithTools(fillTemplate(promptTemplate, vars));
```

After the reply is sent (non-empty), if it was an ambient trigger:

```typescript
if (trigger === 'ambient') {
  const cfgAfter = recordAmbientReply(ensureDailyReset(loadAmbientConfig()));
  saveAmbientConfig(cfgAfter);
  logEvent({ kind: 'ambient.replied', chat: chat.name, trigger: 'ambient' });
}
```

If the reply was empty (claude declined):

```typescript
if (!reply && trigger === 'ambient') {
  logEvent({ kind: 'ambient.declined', chat: chat.name });
  return;
}
```

Important:
- The existing rate-limit check (10s per group) still applies and still
  fires BEFORE the claude call. Ambient doesn't bypass it.
- Preserve all existing debug-logging and structured-logging calls.
- The trigger type union in `src/index.ts` currently is `'mention' | 'reply' | null`. Extend it to include `'ambient'` where needed — update type signatures so downstream logs handle it.

### 4. `README.md` — add an Ambient Replies section

After the Command Mode section, add:

```markdown
## Ambient replies (opt-in)

Beyond mention/reply triggers, the bot can chime in on plain messages
that seem to be about you or about topics you care about. Off by default.

### Enable

```
!ambient on              # turn on globally (applies to all groups you're in)
!ambient off             # master kill switch
!ambient off <chat>      # disable for a specific group
!ambient on <chat>       # re-enable for a previously-disabled group
!ambient status          # show current config
!ambient cap <n>         # change daily reply cap (default 30)
!ambient threshold <n>   # change fuzzy-match threshold, 0-1 (default 0.5)
!ambient refresh         # re-extract topics from voice profile + memory
```

### Topic list

The fuzzy-match bank is built from three sources merged together:
1. Explicit topics you add via `!topic add`
2. Auto-extracted from your voice profile (refreshed on voice-profile change)
3. Aggregated `## Recurring topics` sections across all contact memory files

```
!topic add tennis
!topic add crypto
!topic list
!topic remove tennis
```

### How it works

1. A plain message (no mention, no reply to your message) arrives in a group
2. Fuzzy-match the body against the merged topic bank
3. If score ≥ threshold, call claude with an ambient-flavored prompt that
   strongly prefers silence
4. Claude decides: reply or stay silent. Most of the time: silent.
5. Daily cap of 30 ambient replies prevents runaway chatter; existing 10s
   per-group rate limit still applies.
```

## Acceptance Criteria

- [ ] All `!ambient` sub-commands implemented and tested
- [ ] All `!topic` sub-commands implemented and tested
- [ ] `extractVoiceProfileTopics` + `maybeRefreshVoiceProfileTopics` implemented
- [ ] `src/index.ts` wires the ambient path before the skip-return
- [ ] Ambient replies use `AMBIENT_PROMPT_PREFIX` prepended to `RUNTIME_PROMPT`
- [ ] Successful ambient reply records to `repliesToday` and emits `ambient.replied`
- [ ] Claude declining (empty output) emits `ambient.declined`
- [ ] Ambient path filtered-out messages emit `ambient.skipped` with a reason
- [ ] README has the new Ambient Replies section
- [ ] `npm run build` exits 0
- [ ] `npm test` — all existing tests pass; new tests all pass

## TDD Mode

### Test file: `src/commands.test.ts` — add tests to the existing file

For `!ambient`:
1. `!ambient on` sets masterEnabled=true, persists, reply mentions "on"
2. `!ambient off` sets masterEnabled=false
3. `!ambient off mgz` adds "mgz" to disabledGroups
4. `!ambient off MGZ` normalizes to "mgz" (lowercase + trim)
5. `!ambient on mgz` removes from disabledGroups
6. `!ambient status` includes master state, topic count, cap, threshold
7. `!ambient cap 50` sets cap
8. `!ambient cap abc` → replies with validation error; cap unchanged
9. `!ambient threshold 0.7` sets threshold
10. `!ambient threshold 2` → validation error (out of 0-1 range)

For `!topic`:
11. `!topic add tennis` appends to explicitTopics
12. `!topic add TENNIS` normalizes to "tennis"
13. `!topic add tennis` second time → no duplicate
14. `!topic remove tennis` removes from list
15. `!topic remove nonexistent` → reply indicates not found
16. `!topic list` replies with all 3 sources

### Test file: `src/ambient.test.ts` — extend with extractor tests

Mock `callClaude` at the module boundary OR use the existing `_config`
swap pattern in `src/claude.ts` to run a stub `node -e` that outputs fixed
topics. Avoid calling real claude.

17. `extractVoiceProfileTopics` parses multi-line output: stub outputs "a\nb\nc" → returns ["a","b","c"]
18. `extractVoiceProfileTopics` dedupes: stub outputs "a\nA\na" → returns ["a"]
19. `extractVoiceProfileTopics` caps at 20 lines
20. `extractVoiceProfileTopics` returns [] when file missing
21. `extractVoiceProfileTopics` returns [] when claude fails (stub exits 1)

### Notes for implementer

- When testing the voice profile extractor, the simplest approach is to
  temporarily mutate `_config.command` in `src/claude.ts` to point at `node`
  and pass args/stdin that produce a deterministic echo. See how
  `src/claude.test.ts` does this.
- For `!topic list`, output format should be three clear sections:
  ```
  topics (explicit, N): a, b, c
  topics (voice, M): x, y
  topics (memory, K): p, q, r
  ```
- The ambient `trigger === 'ambient'` case: if extending the current
  `trigger: 'mention' | 'reply' | null` union, make it
  `'mention' | 'reply' | 'ambient' | null` explicitly and update every site
  that reads it.
- The `!ambient off <chat>` command should NOT disable master — only add
  to disabledGroups.
- `!help` text must list the new commands (one line each). Don't make it
  exhaustive — just names + one-line purposes.
