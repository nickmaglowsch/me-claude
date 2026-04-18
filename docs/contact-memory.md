# Contact Memory — Design Doc

Persistent per-contact context files that grow automatically from bot
observations. Turns the bot from "Nick-flavored autocomplete" into "Nick
who actually knows this person".

Modeled on Claude Code's memory system: plain markdown, one file per
contact, appended to and compacted over time, read selectively at reply
time.

## Motivation

The current bot has a voice profile (how Nick writes in general) but no
model of *who he's talking to*. A good reply in a group depends on:
- What Nick already knows about the mention sender (inside jokes, open
  threads, shared history)
- Who else is in the chat (tone shifts when Nick's mother-in-law is
  present vs close friends)
- Unresolved context ("we said we'd grab dinner next week")

Without this, the bot always sounds like Nick meeting this person for
the first time.

## Version picked for v1 (2026-04-18)

1. **Scope**: groups only (same trigger surface as today — no passive DM observation)
2. **Bootstrap**: yes — `npm run memory:bootstrap` scans chat history and seeds files
3. **Cadence**: per-reply — every bot reply triggers a memory update for the sender
4. **Injection**: only when we have info — no `{CONTACT_CONTEXT}` section in the prompt if no relevant memory file exists
5. **Separation**: voice profile stays at `data/voice_profile.md`; contact memories go in `data/contacts/` (different concerns)

## Storage

```
data/contacts/
  5511987654321@c.us.md
  5521999999999@c.us.md
  ...
```

Gitignored. Keyed by `@c.us` JID (canonical, phone-number-derived,
stable). `@lid` IDs are stored *inside* the file as aliases so group
mentions map back to the right file.

### File format

```markdown
# <pushname or phone>

## Identity
- Phone: +55 11 98765-4321
- @c.us: 5511987654321@c.us
- @lid aliases: [261460529811482@lid, ...]
- First seen: YYYY-MM-DD
- Last updated: YYYY-MM-DD

## Facts
- <stable facts about the person>

## Recurring topics
- <things they and Nick repeatedly discuss>

## Open threads
- <unresolved conversations, promises, dates to remember>

## How Nick talks to them
- <relationship tone — differs from general voice profile>

## Raw notes
<free-form append log; compacted into the sections above when file grows too large>
```

## Identity unification (@c.us vs @lid)

WhatsApp assigns each user two unrelated JIDs:
- `@c.us` — phone-number-based, stable, appears in DMs and 1-on-1s
- `@lid` — opaque "linked ID", appears in group mentions and sender fields (post-2024)

They do **not** share any digits. The only way to map one to the other
is to observe the user in a context that exposes both — typically by
looking at the `participants` list on a group `Chat` object, where each
participant has both `id` (c.us) and `lid`.

### Migration strategy
- Canonical key: `@c.us`
- When the bot encounters a group message from/about a `@lid` we haven't
  seen before: query the chat's participants list to find the matching
  `@c.us`, then append the `@lid` to that file's `@lid aliases` section
- If no mapping can be resolved: store under `<lid>@lid.md` as a
  degraded fallback, to be unified later

## Read flow (at reply time)

1. Collect the set of "interesting" participants in the current context window:
   - The mention sender (always)
   - The quoted-message author if `hasQuotedMsg` (always)
   - Up to the 2 most-recent distinct authors in the before/after window
2. Resolve each to `@c.us` via the unification strategy above
3. For each resolved ID: load `data/contacts/<id>.md` if it exists; skip silently otherwise
4. Build `{CONTACT_CONTEXT}` block:
   - If no files loaded: omit the entire block from the prompt (don't even add the header)
   - If files loaded: concatenate with clear per-contact headers; cap total at ~3KB
5. Inject into `RUNTIME_PROMPT` at a new `{CONTACT_CONTEXT}` placeholder

Rule for the LLM (added to RUNTIME_PROMPT): "Use contact context to
shape tone and references. Do not recite facts unprompted — that's
creepy. Use the info to pick sides, remember open threads, and match
the right register."

## Write flow (per reply)

After a successful reply is sent:

1. Build a "memory update" prompt:
   ```
   Here is the current memory file for <pushname>:
   ---
   <current file contents, or "no file yet">
   ---

   Here is what just happened:
   BEFORE: <before-messages>
   MENTION: <mention message>
   AFTER: <after-messages>
   NICK_REPLIED: <bot's reply>

   Produce an updated memory file in the exact format specified.
   Preserve facts. Add anything new. Close any open threads that
   got resolved. Compact if the file would exceed 3KB.
   ```
2. Call `callClaude` a second time with this prompt
3. Atomically write output to `data/contacts/<c.us>.md` (write to tmp, rename)
4. On any failure: log error, do not crash the bot, leave the old file alone

Cost: doubles claude calls per reply on active chats. Acceptable for v1.

## Bootstrap (opt-in)

Separate script: `npm run memory:bootstrap`.

For each group chat Nick participates in:
1. Fetch last N messages (configurable, default 500)
2. For each distinct author in that window, collect their messages and
   messages Nick sent in reply to them
3. For each author with ≥3 messages: call claude with a "build initial
   memory file from these observations" prompt
4. Write the output to `data/contacts/<c.us>.md` (skip if file already exists)

Expected cost: one claude call per (author, group) pair. Can be capped
by `--top-k-chats` and `--top-k-authors-per-chat` flags.

## Prompt changes needed

`RUNTIME_PROMPT` gains an optional section, inserted only when
`{CONTACT_CONTEXT}` is non-empty:

```
# PEOPLE YOU KNOW

Below is what you remember about the people in this chat. Use this to
pick tone and reference shared context. Do not recite these facts
unprompted.

{CONTACT_CONTEXT}
```

New prompt: `MEMORY_UPDATE_PROMPT`. Takes the current memory file
(possibly empty), the observed exchange, and Nick's reply, and emits a
new version of the file.

## What we're explicitly NOT doing in v1

Deferred to future versions:

- **Passive DM observation.** Reading every DM, updating memory without
  replying. Massive privacy/cost bump. Only touch if v1 proves out.
- **Cross-referencing.** If Alice says "that thing Bob told me", we
  don't pull in Bob's file. Too complex, unclear value.
- **Auto-compaction.** We'll log a warning when a file exceeds 4KB but
  not auto-compact until we see how fast files actually grow.
- **`npm run forget <phone>` command.** Manual `rm data/contacts/<id>.md`
  works fine; no CLI needed.
- **Sentiment / relationship-strength scoring.** Facts are enough for v1.
- **Batched writes.** Per-reply is simpler. Move to batched if cost becomes a problem.

## Future phases

### v2: Passive observation (if v1 proves valuable)
- Bot listens to *all* group messages (not just when mentioned), updates
  sender memory without replying
- Adds an "observation" vs "triggered" path to the message handler
- Much faster memory growth; higher claude cost

### v3: DM memory
- Bot reads Nick's DMs and updates memory files
- Privacy impact: every DM hits claude. Needs explicit opt-in and maybe
  a per-chat exclude list
- Useful when a DM contact later appears in a group

### v4: Cross-contact linking
- When Alice mentions Bob, pull in Bob's memory too
- Detect cross-contact mentions via name matching in messages
- Token-budget-heavy; probably needs a "contacts index" file to keep lookups fast

### v5: Proactive capabilities
- Bot notices open threads and can surface them unprompted ("btw, Alice
  asked for an intro to Kavak 3 weeks ago, want me to follow up?")
- Requires a new non-reply channel — notification rather than message
- Out of scope for a reply bot; might want a separate tool

### v6: Memory compaction / maintenance
- Nightly job that runs over all files:
  - Compacts raw notes into structured sections
  - Drops stale open threads older than N months
  - Merges duplicate identities when @lid → @c.us mapping is discovered
- Keeps files from unbounded growth

## Open questions (decide at v1 build time)

- Should bootstrap skip chats where Nick has fewer than M messages total?
  (Probably yes — no point profiling someone we've barely talked to.)
- Should the memory-update prompt see the voice profile too? Or is that
  irrelevant to the memory update task? (Probably irrelevant — keep the
  update prompt minimal and focused.)
- What happens when a memory update call fails mid-reply? Do we retry,
  skip, queue? (v1: skip + log. Simpler.)
- Atomic writes: `fs.writeFileSync(tmp) + fs.renameSync(tmp, final)` or
  just overwrite? (Use the rename trick — cheap and safer.)

## Implementation plan for v1

Proposed task decomposition (each roughly 1 file or a tight cluster):

1. `src/memory.ts` — core memory module: types, `readContactMemory`,
   `writeContactMemory`, `listContactMemories`, `resolveContactKey`
   (maps @lid → @c.us via participants lookup)
2. Prompt updates — add `MEMORY_UPDATE_PROMPT` to `src/prompts.ts`;
   extend `RUNTIME_PROMPT` with optional `{CONTACT_CONTEXT}` section
3. Runtime integration — modify `src/index.ts` to (a) collect
   participants, (b) resolve their IDs, (c) load memory files, (d)
   inject into prompt, (e) call claude again after reply to update
4. Bootstrap script — new `src/bootstrap.ts` + `npm run memory:bootstrap`
5. Tests — memory file parse/write, participant resolution, token budget
   cap, context injection skip-when-empty
6. Docs — update README with the new commands and directory

Read/write paths and placeholder naming follow the existing
`{KEY}` single-brace convention from `src/prompts.ts`.
