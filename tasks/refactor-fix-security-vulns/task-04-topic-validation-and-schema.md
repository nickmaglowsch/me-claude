# Task 04: Topic Input Validation + Ambient Config Schema Guard (V-011)

## Objective

Add a 64-character phrase cap and 200-entry bank cap to `!topic add`, and add a hand-rolled schema validator for `loadAmbientConfig` that rejects structurally malformed files and falls back to defaults with a clear error.

## Target Files

- `src/commands.ts` — `cmdTopic` handler: add length + count caps on `!topic add` (around line 466-479)
- `src/ambient.ts` — `loadAmbientConfig`: add a `validateAmbientConfig` call after `JSON.parse`

## Dependencies

- Depends on: None
- Blocks: Nothing

## Acceptance Criteria

- [ ] `!topic add` rejects phrases longer than 64 characters with a clear reply message
- [ ] `!topic add` rejects adds when `explicitTopics.length >= 200` with a clear reply message
- [ ] `loadAmbientConfig` validates the parsed JSON against the `AmbientConfig` shape; if any required field is missing or has the wrong type, it logs a warning and returns `defaultAmbientConfig()` (same fallback as the current ENOENT path)
- [ ] A structurally valid config still loads and returns the parsed values (no false-positive rejections)
- [ ] No new npm dependencies are added
- [ ] All existing `commands.test.ts` and `ambient.test.ts` tests still pass
- [ ] New tests pass (see Tests section)

## Tests

Add to `src/commands.test.ts` in a new `describe('dispatchCommand — !topic add validation')` block:

```typescript
describe('dispatchCommand — !topic add validation', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-test-'));
    // Create the data dir so saveAmbientConfig can write
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('!topic add phrase > 64 chars is rejected with error reply', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    const longPhrase = 'a'.repeat(65);
    await dispatchCommand(parseCommand(`!topic add ${longPhrase}`)!, ctx);
    expect(replies[0]).toMatch(/too long|64/i);
  });

  it('!topic add accepts phrase exactly 64 chars', async () => {
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    const exactPhrase = 'a'.repeat(64);
    await dispatchCommand(parseCommand(`!topic add ${exactPhrase}`)!, ctx);
    expect(replies[0]).toMatch(/^ok, added/);
  });

  it('!topic add is rejected when bank has 200 entries', async () => {
    // Pre-populate ambient config with 200 explicit topics
    const cfg = {
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: Array.from({ length: 200 }, (_, i) => `topic-${i}`),
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: new Date().toISOString().slice(0, 10),
    };
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'ambient-config.json'),
      JSON.stringify(cfg, null, 2),
      'utf8',
    );
    const replies: string[] = [];
    const ctx = makeCtx(replies, new Map());
    await dispatchCommand(parseCommand('!topic add new-topic')!, ctx);
    expect(replies[0]).toMatch(/limit|200|full/i);
  });
});
```

Add to `src/ambient.test.ts` in a new `describe('loadAmbientConfig schema validation')` block:

```typescript
describe('loadAmbientConfig schema validation', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-schema-test-'));
    fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(obj: unknown): void {
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'ambient-config.json'),
      JSON.stringify(obj),
      'utf8',
    );
  }

  it('valid config loads correctly', () => {
    writeConfig({
      masterEnabled: true,
      disabledGroups: ['chat-a'],
      explicitTopics: ['football'],
      dailyCap: 20,
      confidenceThreshold: 0.6,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg.masterEnabled).toBe(true);
    expect(cfg.explicitTopics).toEqual(['football']);
  });

  it('missing masterEnabled field → returns defaultAmbientConfig', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({ disabledGroups: [], explicitTopics: [] }); // masterEnabled missing
    const cfg = loadAmbientConfig();
    expect(cfg).toEqual(defaultAmbientConfig());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('masterEnabled is string instead of boolean → returns defaultAmbientConfig', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({
      masterEnabled: 'yes',  // wrong type
      disabledGroups: [],
      explicitTopics: [],
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg).toEqual(defaultAmbientConfig());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('explicitTopics is not an array → returns defaultAmbientConfig', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeConfig({
      masterEnabled: false,
      disabledGroups: [],
      explicitTopics: 'football',  // should be array
      dailyCap: 30,
      confidenceThreshold: 0.5,
      voiceProfileTopics: [],
      voiceProfileMtime: 0,
      repliesToday: [],
      lastReset: '2026-04-19',
    });
    const cfg = loadAmbientConfig();
    expect(cfg).toEqual(defaultAmbientConfig());
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
```

## Implementation Details

### src/commands.ts — `cmdTopic` add handler

In `cmdTopic`, inside the `if (sub === 'add')` branch (around line 466), add guards after the empty-phrase check:

```typescript
if (sub === 'add') {
  if (!phrase) {
    await ctx.reply('usage: !topic add <phrase>');
    return;
  }
  // New: length cap
  if (phrase.length > 64) {
    await ctx.reply(`phrase too long (${phrase.length} chars). Max 64.`);
    return;
  }
  // New: bank size cap
  if (cfg.explicitTopics.length >= 200) {
    await ctx.reply(`topic bank full (${cfg.explicitTopics.length}/200 entries). Remove a topic first.`);
    return;
  }
  // existing duplicate check continues...
  const alreadyExists = cfg.explicitTopics.some(t => t.toLowerCase() === phrase);
  ...
}
```

### src/ambient.ts — `validateAmbientConfig` helper + `loadAmbientConfig` call

Add a private validator function before `loadAmbientConfig`:

```typescript
function isValidAmbientConfig(obj: unknown): obj is AmbientConfig {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.masterEnabled === 'boolean' &&
    Array.isArray(c.disabledGroups) &&
    Array.isArray(c.explicitTopics) &&
    typeof c.dailyCap === 'number' &&
    typeof c.confidenceThreshold === 'number' &&
    Array.isArray(c.voiceProfileTopics) &&
    typeof c.voiceProfileMtime === 'number' &&
    Array.isArray(c.repliesToday) &&
    typeof c.lastReset === 'string'
  );
}
```

Update `loadAmbientConfig` to use it:

```typescript
export function loadAmbientConfig(): AmbientConfig {
  const cfgPath = resolvedConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidAmbientConfig(parsed)) {
      console.warn('[ambient] ambient-config.json failed schema validation, using defaults');
      return defaultAmbientConfig();
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('[ambient] failed to parse ambient config, using defaults:', (err as Error).message);
    }
    return defaultAmbientConfig();
  }
}
```

Note: the `as AmbientConfig` cast that currently follows `JSON.parse` is removed; `isValidAmbientConfig` serves as the type guard instead.

### Array element type checking

The `isValidAmbientConfig` validator checks that `disabledGroups`, `explicitTopics`, `voiceProfileTopics`, and `repliesToday` are arrays but does NOT check that every element is a string. This is intentional — it avoids O(n) iteration on large arrays for this low-risk check, and a single non-string element would only cause a downstream runtime type error (which is a benign failure for a personal bot). Adding per-element type checks is out of scope for this task.

## Out of Scope

- Do NOT add zod or any other schema validation library (V-006 skipped; keep dep-free)
- Do NOT add per-element type checking in arrays (over-engineered for this use case)
- Do NOT change the `AmbientConfig` type definition
- Do NOT change any `!topic remove` or `!topic list` behavior
- Do NOT add caps on `voiceProfileTopics` or `repliesToday` arrays (those are system-managed, not user-driven)
