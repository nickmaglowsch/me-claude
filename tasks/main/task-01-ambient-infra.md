# Task 01: Ambient infrastructure (fuzzy match + config + topic bank + prompts + events)

## Objective

Build the pure-logic foundation for ambient replies: fuzzy text matching,
ambient-config persistence, topic-bank construction from three sources
(explicit list + voice profile + memory files), prompt additions, and new
event kinds. NO runtime wiring or commands — those are Task 02.

## Target Files

- `src/fuzzy.ts` (new)
- `src/fuzzy.test.ts` (new)
- `src/ambient.ts` (new)
- `src/ambient.test.ts` (new)
- `src/prompts.ts` (add 2 new exports)
- `src/events.ts` (add new EventKind values)
- `.gitignore` (add `data/ambient-config.json`)

## Context Files

- `tasks/main/shared-context.md`
- `src/prompts.ts` — current RUNTIME_PROMPT structure and fillTemplate style
- `src/events.ts` — current EventKind union
- `src/memory.ts` — readContactMemory patterns for parsing markdown files

## Dependencies

None. Can run alone.

## Requirements

### 1. `src/fuzzy.ts` — Dice coefficient bigram fuzzy match

Pure functions, no deps:

```typescript
// Normalize: lowercase, strip diacritics (NFD + \p{Mn} strip is too much;
// use simple latin-1 replacement: café→cafe, ação→acao), strip punctuation,
// collapse whitespace.
export function normalize(s: string): string;

// Dice coefficient over character bigrams. Returns 0-1.
// Two identical strings → 1.0. Completely disjoint → 0.0.
export function diceSimilarity(a: string, b: string): number;

// Best fuzzy match of any token in `bank` against any word in `body`.
// Returns the top-scoring match with score >= threshold, or null.
// score is the Dice similarity.
export interface FuzzyMatch {
  topic: string;       // the bank entry that matched
  matchedWord: string; // the word in body that matched best
  score: number;       // 0-1
}
export function bestFuzzyMatch(
  body: string,
  bank: string[],
  threshold: number
): FuzzyMatch | null;
```

Implementation notes:
- Normalize both sides before scoring
- If topic contains multiple words (e.g., "crypto investing"), compare the
  full topic against each word in the body AND also against N-word windows.
  Keep simple: compare full normalized topic against each word. A more
  advanced phrase-matching can come later.
- Also compare full normalized topic against the entire normalized body.
  Take the max score.
- Threshold 0.0 → always returns the best match (for tests)
- Empty bank → returns null
- Empty body → returns null

### 2. `src/ambient.ts` — config I/O, topic bank, gate

```typescript
export interface AmbientConfig {
  masterEnabled: boolean;        // default false
  disabledGroups: string[];      // lowercase-normalized chat names
  explicitTopics: string[];      // lowercased
  dailyCap: number;              // default 30
  confidenceThreshold: number;   // default 0.5; range 0-1
  voiceProfileTopics: string[];  // cached extract
  voiceProfileMtime: number;     // mtime of voice_profile.md when extracted
  repliesToday: string[];        // ISO timestamps added to today's bucket
  lastReset: string;             // "YYYY-MM-DD"
}

export const AMBIENT_CONFIG_PATH: string; // "data/ambient-config.json"

export function defaultAmbientConfig(): AmbientConfig;
export function loadAmbientConfig(): AmbientConfig;
  // If file missing → returns defaultAmbientConfig()
  // If malformed → returns default + logs warning
export function saveAmbientConfig(cfg: AmbientConfig): void;
  // Atomic tmp+rename pattern

// If today's date differs from cfg.lastReset, clear repliesToday and set lastReset.
// Returns the possibly-updated config (does NOT save). Pure.
export function ensureDailyReset(cfg: AmbientConfig): AmbientConfig;

// Read all `data/contacts/*.md`, parse "## Recurring topics" section bullets.
// Returns a deduped, lowercased array of topic strings.
export function loadMemoryTopics(): string[];

// Builds the merged topic bank from: explicit + voice-profile-topics + memory-topics.
// Dedupes. Caller can pass an already-loaded memory-topics list (for tests).
export function buildTopicBank(
  cfg: AmbientConfig,
  memoryTopics?: string[],
): string[];

// Gate decision: does this message qualify for ambient consideration?
export interface AmbientDecision {
  pass: boolean;
  reason: string;
  matchedTopic?: string;
  score?: number;
}
export function shouldAmbientReply(params: {
  cfg: AmbientConfig;
  chatName: string;
  messageBody: string;
  topicBank: string[];
}): AmbientDecision;

// After a successful ambient reply, append timestamp + ensureDailyReset.
export function recordAmbientReply(cfg: AmbientConfig): AmbientConfig;
```

### `shouldAmbientReply` logic

In order:
1. `cfg.masterEnabled === false` → `{ pass: false, reason: "master disabled" }`
2. `cfg.disabledGroups` includes normalized `chatName` → `{ pass: false, reason: "group disabled" }`
3. `cfg.repliesToday.length >= cfg.dailyCap` → `{ pass: false, reason: "daily cap reached" }`
4. `messageBody.trim().length < 3` → `{ pass: false, reason: "message too short" }`
5. `topicBank.length === 0` → `{ pass: false, reason: "no topics configured" }`
6. Run `bestFuzzyMatch(messageBody, topicBank, cfg.confidenceThreshold)`
   - If null → `{ pass: false, reason: "no fuzzy match" }`
   - Else → `{ pass: true, reason: "topic match", matchedTopic, score }`

Normalized chatName comparison: lowercase + trim, matching the
`normalizeChatKey` helper from commands.ts. (Add a note in implementation
that we rely on that same normalization; tests can use lowercase directly.)

### 3. `src/prompts.ts` — two additions

Add export `AMBIENT_PROMPT_PREFIX`:

```typescript
export const AMBIENT_PROMPT_PREFIX = `IMPORTANT: This is an AMBIENT trigger. No one @-mentioned Nick and no one replied to him. You're joining the conversation unprompted because the topic seemed relevant.

Ambient replies are high-risk for sounding bot-like or weird. Your default should be SILENCE. Only produce a reply if all three hold:
  1. The message is genuinely about Nick OR about a topic Nick would deeply care about
  2. Nick would realistically chime in here unprompted — not just theoretically have an opinion, but actually bother typing
  3. The reply fits Nick's voice as-is (no "btw" or "just jumping in" scaffolding unless his profile shows that pattern)

If in any doubt, output nothing. Empty output is the RIGHT answer for most ambient triggers.

When you do reply, do NOT acknowledge that you weren't mentioned. Do not say "falando nisso" or "just saw this" — the voice profile governs how Nick would naturally interject.

`;
```

And `VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT`:

```typescript
export const VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT = `You will receive Nick's voice profile — an analysis of how he writes on WhatsApp. Extract a concise list of TOPICS OR INTERESTS he talks about or clearly cares about. The output is a fuzzy-match bank — optimize for recall, not precision. One topic per line. Lowercase. No bullets, no numbering, no explanation. Maximum 20 lines.

Include:
- Named interests (sports he follows, hobbies, places he visits, technologies he uses)
- Work/domain topics
- Recurring life themes (partner's name, pet's name, family, close friends)

Do NOT include:
- Generic categories like "life" or "work" (too broad)
- Words from the DON'Ts section
- Punctuation-only lines

# VOICE PROFILE

{VOICE_PROFILE}

# OUTPUT (one topic per line, max 20, lowercase)`;
```

### 4. `src/events.ts` — add to EventKind union

Add these values (one-line addition each):
- `'ambient.skipped'` — filtered out before LLM call (rate limit, disabled, no match, etc.)
- `'ambient.considered'` — passed filter, claude was called
- `'ambient.replied'` — claude returned non-empty, reply sent
- `'ambient.declined'` — claude returned empty string (LLM declined to chime in)
- `'skip.ambient_disabled'` — a redundant marker for stats aggregation clarity

Add these as pure union additions. Do NOT modify any existing event code.

### 5. `.gitignore`

Append line: `data/ambient-config.json`

## Acceptance Criteria

- [ ] `src/fuzzy.ts` exports `normalize`, `diceSimilarity`, `bestFuzzyMatch`
- [ ] `src/ambient.ts` exports the listed functions and `AmbientConfig` interface
- [ ] Config I/O uses atomic tmp+rename
- [ ] `shouldAmbientReply` implements all 6 gate steps in order
- [ ] `loadMemoryTopics` parses `## Recurring topics` sections from `data/contacts/*.md`
- [ ] `buildTopicBank` merges and dedupes all 3 sources
- [ ] `src/prompts.ts` exports `AMBIENT_PROMPT_PREFIX` and `VOICE_PROFILE_TOPIC_EXTRACTION_PROMPT`
- [ ] `src/events.ts` `EventKind` includes the 5 new kinds
- [ ] `.gitignore` has `data/ambient-config.json`
- [ ] `npm run build` exits 0
- [ ] `npm test` — existing 139 tests still pass; new tests all pass

## TDD Mode

### Test file: `src/fuzzy.test.ts`

Tests to write FIRST:

1. **normalize lowercases**: `normalize("TENNIS")` → `"tennis"`
2. **normalize strips diacritics (basic latin)**: `normalize("café")` → `"cafe"`, `normalize("ação")` → `"acao"`
3. **normalize strips punctuation**: `normalize("tennis!")` → `"tennis"`
4. **normalize collapses whitespace**: `normalize("  hello   world  ")` → `"hello world"`
5. **diceSimilarity identical**: `diceSimilarity("tennis", "tennis")` → `1.0`
6. **diceSimilarity disjoint**: `diceSimilarity("tennis", "xyz")` → close to `0`
7. **diceSimilarity similar**: `diceSimilarity("tennis", "tenis")` → `> 0.7`
8. **diceSimilarity case insensitive through normalize**: `diceSimilarity("Tennis", "TENIS")` → `> 0.7`
9. **bestFuzzyMatch returns top match**: body="I watched tennis yesterday", bank=["tennis","cooking"], threshold=0.5 → `{ topic: "tennis", score: ~1.0 }`
10. **bestFuzzyMatch respects threshold**: body="hello world", bank=["xyz"], threshold=0.5 → `null`
11. **bestFuzzyMatch empty bank**: body="anything", bank=[], any threshold → `null`
12. **bestFuzzyMatch empty body**: body="", bank=["x"], any threshold → `null`
13. **bestFuzzyMatch fuzzy match across small typo**: body="I played tenis", bank=["tennis"], threshold=0.7 → non-null

### Test file: `src/ambient.test.ts`

Isolate via temp cwd + cleanup. Use real fs.

1. **loadAmbientConfig returns defaults when missing**: no file → default config values
2. **save+load roundtrip**: save a config, load, fields match
3. **saveAmbientConfig uses atomic write**: no `.tmp-` files left behind
4. **ensureDailyReset clears on new day**: lastReset="2020-01-01" + some repliesToday → repliesToday=[], lastReset=today
5. **ensureDailyReset noop on same day**: lastReset=today → unchanged
6. **loadMemoryTopics parses ## Recurring topics sections**: write 2 fake contact files with different topics, call loadMemoryTopics, verify merged + deduped
7. **loadMemoryTopics empty when no contacts**: empty data/contacts → `[]`
8. **loadMemoryTopics handles files without the section**: files with no `## Recurring topics` → `[]`
9. **buildTopicBank merges all 3 sources**: explicit=["a"], voice=["b"], memory=["c"] → contains a,b,c; dedupes repeats
10. **shouldAmbientReply master-disabled returns pass=false**: masterEnabled=false → pass=false, reason mentions master
11. **shouldAmbientReply chat in disabledGroups returns pass=false**
12. **shouldAmbientReply daily cap hit returns pass=false**: repliesToday.length=dailyCap → pass=false
13. **shouldAmbientReply short message returns pass=false**: messageBody="ok" → pass=false
14. **shouldAmbientReply empty topic bank returns pass=false**: topicBank=[] → pass=false
15. **shouldAmbientReply no fuzzy match returns pass=false**
16. **shouldAmbientReply happy path returns pass=true with matchedTopic and score**: topicBank=["tennis"], body="watched tennis yesterday" → pass=true
17. **recordAmbientReply appends timestamp**: length goes +1
18. **recordAmbientReply triggers daily reset if on a new day**: lastReset=old + one ambient → repliesToday has 1 entry (the new one), lastReset=today

### Test isolation

Same pattern as `memory.test.ts`/`memory-guard.test.ts`:
- `beforeEach`: mkdtemp, chdir, mkdir data/contacts and data/
- `afterEach`: chdir back, rm tmpDir

### Mocking discipline

- Do NOT mock fs. Use temp dirs.
- Do NOT mock Date for routine tests. For daily-reset tests, use explicit ISO date strings.
- Do NOT mock fuzzy/dice — tests of ambient.ts should use real implementations.

### Notes for implementer

- `AmbientConfig` fields are all simple JSON types — no Dates, Maps, or custom classes. Serializes cleanly.
- `AMBIENT_CONFIG_PATH` should use `path.join(process.cwd(), 'data', 'ambient-config.json')`
- Keep `data/` dir creation defensive (`mkdirSync(..., { recursive: true })` before write)
- Threshold default 0.5 is permissive — that's fine; false positives get filtered by the claude call which prefers silence
- Dice coefficient: count distinct character bigrams in each string, intersection size × 2 / total bigrams
