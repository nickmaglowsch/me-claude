# Task 03: Self-chat command mode

## Objective

When Nick sends a message to HIMSELF on WhatsApp starting with `!`, treat
it as a command (not a mention). Parse and dispatch the command, reply
in the same self-chat with the result. No other chat can trigger command
mode. Commands let Nick teach/correct the bot without editing files.

## Target Files

- `src/commands.ts` (new — parser + dispatcher)
- `src/commands.test.ts` (new)
- `src/index.ts` (add the command gate + handler)
- `README.md` (add a Command Mode section)

## Context Files

- `tasks/main/shared-context.md`
- `src/index.ts` — current `message_create` handler and the `fromMe` gate
- `src/memory.ts` — existing read/write/list functions (commands will use these)
- `src/events.ts` — NEW from task 02; commands should emit events
- `docs/architecture-improvements.md` — item 5 specification

## Dependencies

- **Depends on Task 02** for `events.ts` (so `!status` can read `data/events.jsonl`).
- Independent of Task 01.

## Requirements

### 1. Security model

Command mode fires IFF all three hold:
- `msg.fromMe === true`
- `chat.id._serialized === ownerCusId` (the self-chat)
- `msg.body.trim().startsWith('!')`

Must NOT fire for:
- Messages Nick sends in other chats (groups, DMs to anyone else) starting with `!`
- Messages from anyone else that happen to contain `!` as first char

Rationale: only Nick's authenticated WhatsApp session produces `fromMe`
messages. The self-chat scoping ensures accidental `!!!` reactions in
other chats don't trigger commands. See `docs/architecture-improvements.md`
item 5 for full rationale.

### 2. Dispatcher architecture

`src/commands.ts` exports:

```typescript
export interface CommandContext {
  ownerCusId: string;
  // A callback the dispatcher uses to send reply messages back into the
  // self-chat. Index.ts supplies this; tests supply a stub.
  reply: (text: string) => Promise<void>;
  // In-memory state, passed in so the runtime can own it
  silences: Map<string, number>; // chat-name → muted-until-ms; "*" key for global
}

export interface ParsedCommand {
  name: string;          // e.g. "remember", "who", "status"
  argv: string[];        // tokens after the command name
  raw: string;           // full body after the leading "!"
}

export function parseCommand(body: string): ParsedCommand | null;
// Returns null if body doesn't start with "!" or has no command name.

export async function dispatchCommand(
  parsed: ParsedCommand,
  ctx: CommandContext
): Promise<void>;
// Executes the command. Always replies in self-chat with result or error.
// Catches errors internally; never throws.
```

### 3. Commands to implement (v1)

Each command below. Reply text goes to the self-chat via `ctx.reply`.

| Command | Syntax | Behavior |
|---|---|---|
| `!help` | `!help` | List all commands with one-line descriptions |
| `!remember <jid> <fact>` | `!remember 5511987654321@c.us Alice got a dog` | Load the contact file (or create a minimal one if missing), append the fact to `## Facts`, update `Last updated`, save via `writeContactMemoryGuarded` (task 01) or `writeContactMemory` (fallback if task 01 isn't merged yet). Reply `ok, remembered: <fact> for <jid>` |
| `!forget <jid>` | `!forget 5511987654321@c.us` | Delete `data/contacts/<jid>.md`. Reply `ok, forgot <jid>` or `no file for <jid>` |
| `!who <jid>` | `!who 5511987654321@c.us` | Read the file and reply with its contents. If missing, reply `no memory file for <jid>`. If the file is huge (>3000 chars), truncate and note so. |
| `!status` | `!status` | Read events from `data/events.jsonl` (last 24h), reply with a terse summary: X replies, Y skips, Z errors, latest reply N min ago in group M |
| `!silence <chat-name> <duration>` | `!silence mgz 2h`, `!silence mgz 30m`, `!silence mgz 1d` | Parse duration (supports `m`, `h`, `d`). Set `ctx.silences.set(chatName, Date.now() + ms)`. Reply `silenced mgz until 16:45`. Duration `all` special-cases to global mute via key `*` |
| `!silence all <duration>` | `!silence all 1h` | Mute globally via key `*` |
| `!resume` | `!resume` | Clear `ctx.silences`. Reply `ok, resumed` |

Unknown command (e.g. `!asdf`): reply `unknown command: asdf. try !help`.

### 4. Parser details

`parseCommand("!remember 5511987654321@c.us Alice got a dog")`:
- name: `"remember"`
- argv: `["5511987654321@c.us", "Alice", "got", "a", "dog"]`
- raw: `"remember 5511987654321@c.us Alice got a dog"`

For `!remember` specifically, the "fact" is argv[1..].join(' '). The
dispatcher is responsible for that reassembly — the parser is dumb.

For `!who` where the user might pass a name instead of JID (e.g. `!who Alice`):
- If the single arg ends with `@c.us`, treat as JID
- Else: Grep `data/contacts/` for files matching the name (case-insensitive). If 1 match, use it. If 0, reply "no match". If >1, reply with the list of candidates and tell Nick to use the JID.

### 5. Silence enforcement in the runtime

`src/index.ts` maintains the `silences` Map. In the existing handler,
after the rate-limit check and before the Claude call, check:

```typescript
if (silences.has('*') && silences.get('*')! > Date.now()) {
  logEvent({ kind: 'skip.silenced', reason: 'global' });
  return;
}
if (silences.has(chat.name) && silences.get(chat.name)! > Date.now()) {
  logEvent({ kind: 'skip.silenced', reason: 'per-chat' });
  return;
}
```

(Add `skip.silenced` to the EventKind union in task 02; if task 02 isn't merged yet, use generic `skip.other` and note in implementation notes.)

### 6. Integration in `src/index.ts`

In the `message_create` handler, BEFORE the existing group-chat gate:

```typescript
// Self-chat command check: fromMe + self-chat + starts with "!"
if (msg.fromMe && chat?.id?._serialized === ownerCusId) {
  const body = (msg.body || '').trim();
  if (body.startsWith('!')) {
    const parsed = parseCommand(body);
    if (parsed) {
      logEvent({ kind: 'command.received', ... });
      await dispatchCommand(parsed, { ownerCusId, reply: (text) => chat.sendMessage(text), silences });
      return;
    }
  }
}
// ... existing gates continue below
```

Make sure to get the chat object BEFORE the `fromMe` gate so we can
detect self-chat. The existing code does `msg.getChat()` right after the
debug log — reorder if needed.

### 7. Recursion guard

When the bot replies to a command, the reply is itself a `fromMe` message
in the self-chat and will fire `message_create` again. To avoid infinite
loops:

- Bot replies to commands must NOT start with `!` (enforce this in the
  dispatcher — prefix every reply with `ok, ` or similar, never with `!`)
- Additionally: track outbound message IDs in a small LRU-ish Set
  (`recentOutboundIds`) and skip any `message_create` whose `msg.id._serialized`
  is in the set

### 8. README update

Add a new `## Command Mode` section to `README.md` listing every command
with a one-line example. Explain the security model briefly.

## Acceptance Criteria

- [ ] `src/commands.ts` exports `parseCommand`, `dispatchCommand`, `CommandContext`, `ParsedCommand`
- [ ] All commands from the table above implemented
- [ ] Self-chat gate in `src/index.ts` works — verified via tests with mocked chat/msg objects
- [ ] Commands never trigger in other chats (even if Nick sends `!...` there)
- [ ] Recursion guard prevents bot replies from being re-parsed as commands
- [ ] Silence enforcement in handler works
- [ ] README has a Command Mode section
- [ ] `npm run build` exits 0; `npm test` green
- [ ] New tests cover: parser, every command's happy path, unknown command, silence set/enforce/clear

## TDD Mode

### Test file: `src/commands.test.ts`

### Tests for parseCommand:

1. **Plain command**: `parseCommand("!help")` → `{ name: "help", argv: [], raw: "help" }`
2. **Command with args**: `parseCommand("!remember jid1 some fact")` → `{ name: "remember", argv: ["jid1", "some", "fact"], raw: "remember jid1 some fact" }`
3. **Command with extra whitespace**: `parseCommand("  !help  ")` → returns parsed (trim before parse) OR null depending on your design; pick one and stick to it
4. **No bang**: `parseCommand("help")` → null
5. **Only bang**: `parseCommand("!")` → null (no command name)
6. **Empty string**: `parseCommand("")` → null

### Tests for dispatchCommand:

Use a stub `reply` function (appends to an array) and assert on replies.

1. **!help lists all commands**: reply contains `!remember`, `!forget`, `!who`, `!status`, `!silence`, `!resume`
2. **!unknown unknown command**: `!asdf` → reply contains `unknown command: asdf`
3. **!remember happy path**: create a temp data/contacts/<jid>.md with seed content, run `!remember <jid> new fact`, verify the file now contains "new fact" in Facts section, verify reply confirms
4. **!remember creates file if missing**: no existing file → file is created with minimal template; reply confirms
5. **!forget happy path**: file exists → file is deleted; reply confirms
6. **!forget missing file**: no file → reply says no file
7. **!who with jid returns file contents**: file has content "hello world" → reply contains "hello world"
8. **!who with missing jid**: no file → reply says no memory
9. **!who with name resolves via grep**: create file containing "Alice" → `!who Alice` → reply with file contents
10. **!who with ambiguous name**: two files mention "Alice" → reply says multiple matches, lists them
11. **!status with empty events**: empty events.jsonl → reply with zeroed summary
12. **!status with events**: write 3 reply.sent events, run !status → reply mentions "3 replies"
13. **!silence parses duration**: `!silence mgz 2h` → silences.get("mgz") is ~2h in the future
14. **!silence all**: `!silence all 1h` → silences.get("*") is ~1h in future
15. **!resume clears silences**: add silence, call !resume, silences.size === 0

### Mocking discipline

- Use real fs, temp dirs for contact files and events.jsonl
- Use a stub reply function (`async (text) => replies.push(text)`)
- Don't mock Date; use actual Date.now() comparisons with reasonable tolerance

### Notes for implementer

- Keep the command dispatcher OFFLINE from whatsapp-web.js entirely. Test it with just the data layer + stub reply.
- Silence duration parser: `2h` = 7200000ms, `30m` = 1800000ms, `1d` = 86400000ms. If parse fails, reply with usage error.
- Handling commands that throw internally: catch and reply `error: <message>`. Never let the bot crash.
