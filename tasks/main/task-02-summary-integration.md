# Task 02: `!summary` command + runtime persistence wiring

## Objective

Wire the groups persistence module from Task 01 into the bot: persist
every group message, add the `!summary` command, and document in README.

## Target Files

- `src/prompts.ts` (add `SUMMARY_PROMPT`)
- `src/commands.ts` (add `!summary` handler)
- `src/commands.test.ts` (tests for `!summary`)
- `src/index.ts` (call `persistMessage` at top of handler)
- `src/events.ts` (add new EventKind values)
- `README.md` (document command + layout)

## Context Files

- `tasks/main/shared-context.md` — full spec
- `tasks/main/task-01-groups-persistence.md` — Task 01 contract
- `src/commands.ts` — existing `!` command dispatcher, `parseCommand` shape
- `src/index.ts` — current handler structure and order of gates
- `src/claude.ts` — `callClaude` (no-tools) for the summary claude call
- `src/groups.ts` — Task 01 exports you're wiring in

## Dependencies

**Depends on Task 01** — all of `src/groups.ts`'s public API.

## Requirements

### 1. `src/prompts.ts` — add `SUMMARY_PROMPT`

```typescript
export const SUMMARY_PROMPT = `You will see messages from a WhatsApp group chat on a specific date. Produce a concise summary for Nick (the bot owner) who wants to catch up on what was discussed.

# GROUP

{GROUP_NAME}

# DATE

{DATE}

# MESSAGES

Each line is formatted as: [HH:MM] <sender>: <body>
Messages marked (me) are from Nick himself.

{MESSAGES}

# OUTPUT FORMAT

Output plain text for Nick to read on his phone. Keep it tight.

Structure:
1. One-line vibe check ("mostly logistics for Saturday's dinner" / "drama about X / Y exchange / slow day")
2. Bulleted list of discrete topics/events discussed (max 8 bullets)
3. Optional "Open threads" section listing unresolved questions or promises from today that Nick should know about

If the day had very little activity, say so in one sentence and stop. No padding.

Do NOT include every message verbatim. Synthesize.`;
```

### 2. `src/commands.ts` — add `!summary` command

Add to `HELP_TEXT` (alongside the existing commands):

```
!summary <group> [date]   Summarize a group's day. date: today | yesterday | Nd | YYYY-MM-DD
```

Add a handler `cmdSummary(argv: string[], ctx: CommandContext)`:

**Parsing:**
- `argv[0]` = group query (required). If missing → reply with usage hint.
- `argv[1..].join(' ')` = date spec (optional). Parse with `parseDateSpec(raw)`:
  - `"today"` or undefined → today
  - `"yesterday"` → yesterday
  - `/^\d+d$/` → N days ago
  - `/^\d{4}-\d{2}-\d{2}$/` → exact
  - else → null (usage error)

**Lookup:**
- `findGroupsByName(groupQuery)` from `src/groups.ts`
- 0 matches → reply `"no group matching <query>"`
- >1 matches → reply `"multiple matches: <list names>. be more specific."`
- 1 match → proceed with that group

**Read:**
- `readDayMessages(match.folder, localDate)`
- If empty → reply `"no messages for <group> on <date>"`

**Format and call claude:**
- Format each message as `[HH:MM] <from_name>: <body>` with `(me)` suffix if `from_me`
- Build prompt via `fillTemplate(SUMMARY_PROMPT, { GROUP_NAME, DATE, MESSAGES })`
- `callClaude(prompt)` — no tools, just text-in/text-out
- Trim result. If empty → reply `"summary was empty"`. Else reply with the summary.

**Log events:**
- `summary.requested` at start
- `summary.no_match` if no group
- `summary.multi_match` if ambiguous
- `summary.empty` if no messages
- `summary.generated` on success (include duration, message count, chat name)

**Errors:**
- Wrap the claude call in try/catch. Reply `"summary failed: <msg>"` on error.

### 3. Date parsing helper

```typescript
// Parse user's date spec into a local YYYY-MM-DD string.
// Returns null if unrecognized.
export function parseDateSpec(raw?: string): string | null;
```

Place in `src/commands.ts` (or a small util) — this is a pure function,
easy to test.

### 4. `src/index.ts` — persist every group message

At the TOP of the `message_create` handler, after `chat.isGroup` is
confirmed true and BEFORE all the fromMe/mention/rate-limit/ambient
gates:

```typescript
// Archive every group message for summary/search. Errors are swallowed
// inside persistMessage; no gating here.
try {
  const folder = ensureGroupFolder(chat.id._serialized, chat.name ?? '');
  const contact = msg.fromMe
    ? undefined
    : await msg.getContact().catch(() => undefined);
  const fromJid = (contact?.id?._serialized ?? msg.author ?? msg.from ?? '') as string;
  const fromName = contact?.pushname || contact?.number || (msg.fromMe ? 'Nick' : 'Unknown');
  const tsMs = (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
  const body = msg.type === 'chat' ? (msg.body ?? '') : `[${msg.type}]`;

  persistMessage({
    chatJid: chat.id._serialized,
    chatName: chat.name ?? '',
    msg: {
      ts: new Date(tsMs).toISOString(),
      local_date: localDate(tsMs),
      from_jid: fromJid,
      from_name: fromName,
      body,
      from_me: !!msg.fromMe,
      type: msg.type ?? 'unknown',
      id: msg.id?._serialized ?? '',
      has_quoted: !!msg.hasQuotedMsg,
      quoted_id: null,
    },
  });
  dbg(`persisted to ${folder}/${localDate(tsMs)}`);
} catch (e) {
  dbg(`persist error: ${(e as Error).message}`);
}

// existing gates continue below...
```

Skip persisting system messages entirely — if `msg.type` is a known
system type (list them: `'e2e_notification'`, `'notification'`,
`'notification_template'`, `'gp2'`, `'group_notification'`), don't record.

Also add an event log:
```typescript
logEvent({ kind: 'group.persisted', chat_id: chat.id._serialized, chat: chat.name, msg_type: msg.type });
```

Keep it light-weight — this fires on EVERY group message, so tokens-in /
out / claude_duration are all absent.

### 5. `src/events.ts` — add new EventKind values

Add to the union:
- `'group.persisted'`
- `'summary.requested'`
- `'summary.no_match'`
- `'summary.multi_match'`
- `'summary.empty'`
- `'summary.generated'`
- `'summary.error'`

### 6. README update

Add a new section after "Ambient replies":

```markdown
## Group message archive + summaries

The bot archives every group message it sees to disk for later lookup.

Layout:
data/groups/
  .index.json
  <folder>/
    YYYY-MM-DD.jsonl

Folder names are slugified chat names (lowercase, accent-stripped,
dash-separated). A manifest at `data/groups/.index.json` maps group JIDs
to folders. Everything under `data/groups/` is gitignored.

### !summary command

Ask the bot to summarize a group's day:

  !summary <group> [date]

Examples:

  !summary mgz                  # today in the mgz group
  !summary mgz yesterday
  !summary reptime 3d           # 3 days ago
  !summary oe 2026-04-15

Group name is fuzzy-matched. If multiple groups match, the bot lists
candidates and asks for a more specific query.

Summaries are generated by a one-shot claude call — no tools, no memory
file updates. Plain summary, bullet list of topics, optional open
threads.
```

## Acceptance Criteria

- [ ] `src/prompts.ts` exports `SUMMARY_PROMPT`
- [ ] `src/commands.ts` exports `parseDateSpec`; `!summary` wired into dispatcher
- [ ] `src/index.ts` calls `persistMessage` early in the handler, swallows errors
- [ ] System messages are NOT persisted (by type check)
- [ ] `!summary` handles: no group match, multiple matches, empty day, happy path, claude error
- [ ] Event kinds emitted at the right sites
- [ ] `!help` text includes `!summary`
- [ ] README has the new section
- [ ] `npm run build` exits 0; `npm test` all green (existing 196 plus new)

## TDD Mode

### Tests to add to `src/commands.test.ts`

**parseDateSpec** (pure function, easy tests)
1. `parseDateSpec("today")` or `parseDateSpec(undefined)` → today's YYYY-MM-DD
2. `parseDateSpec("yesterday")` → yesterday's date
3. `parseDateSpec("3d")` → 3 days ago
4. `parseDateSpec("2026-04-15")` → `"2026-04-15"`
5. `parseDateSpec("not-a-date")` → `null`
6. `parseDateSpec("")` → today (treat empty as "today" default)

**!summary** (use a stub `ctx.reply` and real groups fs in temp cwd;
mock the claude call by swapping `_config.command` in `src/claude.ts` to
a `node -e` that outputs a fixed summary)
7. `!summary` with no args → reply contains "usage" or "missing"
8. `!summary <non-existent>` → reply `"no group matching ..."`
9. `!summary <ambiguous>` when index has two similarly-named groups → reply lists both
10. `!summary mgz` with an empty JSONL for today → reply `"no messages for mgz on <today>"`
11. `!summary mgz` with 3 messages → stub claude returns "Summary!" → reply contains "Summary!"
12. `!summary mgz yesterday` reads yesterday's file (not today's)
13. `!summary mgz 2d` reads file from 2 days ago
14. `!summary mgz 2026-04-15` reads that exact date's file
15. `!summary mgz` when claude subprocess errors → reply contains "summary failed"

### Test isolation

Same pattern as `commands.test.ts` existing tests — temp cwd per test,
cleanup in afterEach.

### Notes for implementer

- For date tests, be careful about timezone boundaries. Use
  `new Date()` at test time and compute expected values the same way the
  implementation does — don't hardcode dates.
- For "happy path" claude stub: set `_config.command = 'node'`, pass
  `['-e', 'process.stdin.on("data",()=>{}); process.stdin.on("end", ()=> console.log("Summary!"))']` — pattern matches existing claude tests.
- Don't add tests for the `persistMessage` hook in `src/index.ts` — that
  path requires a whatsapp-web.js mock which is out of scope for this
  task. Persistence is tested in Task 01's `groups.test.ts`.
