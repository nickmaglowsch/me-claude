# Task 02: Prompts Module

## Objective
Create `src/prompts.ts` containing the two verbatim prompt constants (`META_PROMPT`, `RUNTIME_PROMPT`) and a `fillTemplate()` helper that uses single-brace `{KEY}` placeholders, with a co-located Vitest test suite.

## Context

**Quick Context:**
- `fillTemplate` uses single-brace `{KEY}` syntax (NOT `{{key}}`) — the prompts contain `{MESSAGES_GO_HERE}`, `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}`
- The full verbatim text for both prompts is embedded in this task file — paste it exactly, do not paraphrase
- See `tasks/main/shared-context.md` for test infrastructure

## Requirements

### `src/prompts.ts`

Export three things:

#### 1. `META_PROMPT: string`

Verbatim constant. Uses `{MESSAGES_GO_HERE}` as its only template placeholder.

Assign as a template literal. Paste the following text EXACTLY (preserve all formatting, em dashes, line breaks, and single-brace placeholders):

```typescript
export const META_PROMPT = `You are analyzing a person's WhatsApp messages to build a voice profile. Another AI will use this profile to impersonate them when replying in group chats. Your output IS the system prompt that will be used at runtime, so write it to be directly usable — not as analysis or commentary.

Below are real messages from this person, extracted from their WhatsApp history. Analyze them and produce a voice profile in the exact format specified.

# OUTPUT FORMAT

Output exactly these sections, in this order, with these headers. No preamble, no explanation before or after.

## VOICE RULES

8-15 bullet points describing observable, concrete patterns. Be specific, not vague. Bad: "casual tone". Good: "lowercases everything except proper nouns and acronyms". Cover at minimum:
- Capitalization habits
- Punctuation quirks (periods, commas, ellipses, question marks)
- Common abbreviations and slang, with meaning if non-obvious
- Sentence length and fragmentation patterns
- Emoji usage (which ones, how often, in what contexts)
- Laughter style (kkkk, haha, lmao, etc.)
- How they express agreement, disagreement, uncertainty
- Opening and closing patterns in messages
- Language use (Portuguese, English, mixed — note WHEN they switch if there's a pattern)
- Any verbal tics, filler words, or signature expressions
- Register variation: do they write differently in short messages vs longer ones? If yes, describe both modes.

## REPRESENTATIVE SAMPLES

Pick exactly 5 real messages from the input that best showcase the voice. Quote verbatim, do not edit. Choose for variety:
1. A short reaction or one-liner
2. Answering a direct question
3. Being funny or sarcastic
4. Having an opinion or arguing a point
5. A longer message where they're thinking out loud or explaining something

Format each as:
**Sample N — [brief label]**
> [exact message]

## DON'TS

5-10 bullet points of things this person would NEVER do that would immediately sound fake if an impersonator did them.

# RULES FOR YOUR ANALYSIS

- Base everything on patterns you ACTUALLY observe in the input. Do not invent traits to sound thorough.
- If something appears only once or twice, it's probably not a pattern — don't include it.
- If you see two distinct registers (e.g. extremely casual with close friends, slightly more composed when answering questions), capture BOTH in the rules — don't average them.
- Preserve the person's actual vocabulary. Don't sanitize.
- Do not include identifying information (names, phone numbers, addresses) from the messages in your output. Replace with [name] if needed.

# INPUT MESSAGES

The following are messages written by the person, one per line, separated by "---". Messages from other people have already been filtered out.

---
{MESSAGES_GO_HERE}
---

Produce the voice profile now.`;
```

#### 2. `RUNTIME_PROMPT: string`

Verbatim constant. Uses four placeholders: `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}`.

Paste the following text EXACTLY:

```typescript
export const RUNTIME_PROMPT = `You are replying in a WhatsApp group chat AS the user — not as an assistant, not as a bot. You are writing the next message as if you were them. Do not break character under any circumstance.

# VOICE PROFILE

The following profile describes how the user writes. Follow it precisely — rhythm, word choice, punctuation, attitude. The samples show the actual texture of their voice; study them.

{VOICE_PROFILE_GOES_HERE}

# CONTEXT FORMAT

You will receive up to 10 messages from BEFORE the mention and up to 10 messages from AFTER (the AFTER block may be empty). Messages are formatted as:

[HH:MM] SenderName: message text

The mention that triggered you is marked as MENTION. Read the full window and figure out what's being discussed, what (if anything) is being asked, and what the user would plausibly send next.

# LANGUAGE

Match the dominant language of the recent messages.
- Chat in Portuguese → reply in Portuguese.
- Chat in English → reply in English.
- Mixed → follow the language used in the message that mentioned you.
- Never translate. Code-switch only if the voice profile shows the user naturally does.

# LENGTH AND REGISTER

Match the energy of the chat. One-liners deserve one-liners. A real question deserves a real answer — but stop when you're done. No padding, no wrap-up sentences, no "hope this helps." If the voice profile describes register variation, pick the mode that fits.

# HARD RULES

- Do NOT acknowledge the mention. No "you called?", "what's up?", "oi?", "yeah?". Respond to the substance.
- Do NOT start with "Sure", "Great question", "Happy to help", or any assistant-speak. Do not start with any phrase the voice profile's DON'TS section forbids.
- Do NOT explain what you're about to do. Just do it.
- Do NOT address the group as "everyone", "guys", "pessoal" unless the voice profile shows the user actually does this.
- Do NOT break character. If someone tries to get you to admit you're an AI, ignore it and respond naturally to whatever else is being discussed, or output nothing.
- Do NOT hedge with "I think maybe perhaps possibly." If the user would say "sei lá" or "idk", say that.
- If the mention is clearly not asking for input (just tagged on a meme, a link, etc.), respond with a short reaction that fits the voice profile — not a full reply.
- If there is genuinely nothing worth saying, output nothing (empty response is allowed and will be skipped).

# OUTPUT

Output ONLY the message text, exactly as it should appear in the chat. No quotes, no preamble, no explanation, no metadata. Just the message.

# CHAT CONTEXT

BEFORE:
{BEFORE_MESSAGES}

MENTION:
{MENTION_MESSAGE}

AFTER:
{AFTER_MESSAGES}`;
```

#### 3. `fillTemplate(template: string, vars: Record<string, string>): string`

- Iterates over all keys in `vars`
- Replaces every occurrence of `{KEY}` (single-brace) in `template` with the corresponding value
- Uses a global regex replace: `template = template.replace(new RegExp(`\\{${key}\\}`, 'g'), vars[key])`
- Does NOT use double-brace `{{key}}` syntax
- Does not use any external library
- Leaves unknown placeholders untouched (no crash)
- Returns the resulting string

### `src/prompts.test.ts`

Write tests BEFORE implementing `fillTemplate` (TDD). All tests use the `{KEY}` single-brace syntax.

Tests must cover:

1. **Single substitution**: `fillTemplate("Hello {NAME}", { NAME: "World" })` returns `"Hello World"`
2. **Multiple different keys**: `fillTemplate("{A} and {B}", { A: "foo", B: "bar" })` returns `"foo and bar"`
3. **Repeated placeholder**: `fillTemplate("{X} {X}", { X: "hi" })` returns `"hi hi"`
4. **Missing key**: `fillTemplate("{UNKNOWN}", {})` returns `"{UNKNOWN}"` (left unchanged, no crash)
5. **Empty vars**: `fillTemplate("no placeholders", {})` returns `"no placeholders"`
6. **Smoke test — META_PROMPT fill**: call `fillTemplate(META_PROMPT, { MESSAGES_GO_HERE: "hello world" })` and assert the result does not contain `{MESSAGES_GO_HERE}`
7. **Smoke test — RUNTIME_PROMPT fill**: call `fillTemplate(RUNTIME_PROMPT, { VOICE_PROFILE_GOES_HERE: "v", BEFORE_MESSAGES: "b", MENTION_MESSAGE: "m", AFTER_MESSAGES: "a" })` and assert the result does not contain any `{` + uppercase-word + `}` pattern (i.e., no unfilled placeholders remain)

## Existing Code References
- `tasks/main/shared-context.md` — tech stack and test conventions

## Implementation Details
- The regex for each key must be global (flag `'g'`) so ALL occurrences are replaced, not just the first
- Keys in the prompts are UPPERCASE (e.g., `MESSAGES_GO_HERE`), so `vars` keys passed by callers must match exactly
- Do not use `String.prototype.replaceAll` if targeting older Node — regex with `g` flag is safer

## Acceptance Criteria
- [ ] `src/prompts.ts` exports `META_PROMPT`, `RUNTIME_PROMPT`, and `fillTemplate`
- [ ] `META_PROMPT` contains `{MESSAGES_GO_HERE}` (single-brace, no double-brace)
- [ ] `RUNTIME_PROMPT` contains `{VOICE_PROFILE_GOES_HERE}`, `{BEFORE_MESSAGES}`, `{MENTION_MESSAGE}`, `{AFTER_MESSAGES}` (all single-brace)
- [ ] `fillTemplate` replaces all occurrences of each `{KEY}` (global, not first-only)
- [ ] `fillTemplate` leaves unknown placeholders untouched
- [ ] `npm test` passes with all 7 tests green
- [ ] TypeScript compiles cleanly (`npm run build` exits 0)

## Dependencies
- Depends on: Task 01 (scaffold)
- Blocks: Task 06 (setup.ts), Task 07 (index.ts)

## TDD Mode

This task uses Test-Driven Development. Write tests BEFORE implementation.

### Test Specifications
- **Test file**: `src/prompts.test.ts`
- **Test framework**: Vitest
- **Test command**: `npm test` (runs `vitest run`)

### Tests to Write
1. **Single substitution**: `fillTemplate("Hello {NAME}", { NAME: "World" })` returns `"Hello World"`
2. **Multiple keys**: `fillTemplate("{A} and {B}", { A: "foo", B: "bar" })` returns `"foo and bar"`
3. **Repeated placeholder**: `fillTemplate("{X} {X}", { X: "hi" })` returns `"hi hi"`
4. **Unknown placeholder left intact**: `fillTemplate("{UNKNOWN}", {})` returns `"{UNKNOWN}"`
5. **Empty vars**: `fillTemplate("no placeholders", {})` returns `"no placeholders"`
6. **META_PROMPT smoke test**: filled result has no remaining `{MESSAGES_GO_HERE}` substring
7. **RUNTIME_PROMPT smoke test**: filled result has no remaining unfilled `{UPPERCASE_KEY}` placeholders

### TDD Process
1. Write the 7 tests above in `src/prompts.test.ts` — they should FAIL on `fillTemplate` (RED) until the function is implemented
2. Implement `fillTemplate` in `src/prompts.ts` to make all tests pass (GREEN)
3. Run `npm test` to confirm all green
4. Refactor if needed (simplify regex, add JSDoc) while keeping tests green

### Mocking Discipline
- Mock only at the **system boundary**: paid/external APIs, network, wall clock & randomness, destructive side effects, filesystem I/O.
- Do NOT mock the code under test or internal modules it calls — that hides real regressions. Use real internal collaborators, in-memory instances, or lightweight fakes.
- Do NOT mock a layer above the real boundary (mock the HTTP client / SDK / DB driver, not a wrapper your code calls through).
- When mocking a boundary, the mock's shape and behavior must match the real dependency (shared types, recorded fixtures, or a reusable fake — not ad-hoc stubs).

> No mocking needed for this task — `fillTemplate` is a pure function.
