# Task 03: Safe String Replace in fillTemplate (V-010)

## Objective

Replace the `new RegExp(...)` construction in `fillTemplate` with a split/join approach that is immune to regex metacharacter injection in template key names.

## Target Files

- `src/prompts.ts` — rewrite the inner loop body of `fillTemplate` (lines 236-244); the function signature and all callers stay the same

## Dependencies

- Depends on: None
- Blocks: Nothing

## Acceptance Criteria

- [ ] `fillTemplate` no longer calls `new RegExp` anywhere
- [ ] All existing `fillTemplate` tests in `src/prompts.test.ts` still pass unchanged
- [ ] A new test with a key containing regex metacharacters (`[`, `(`, `.`, `*`, `+`, `?`, `{`) passes without throwing and produces correct output
- [ ] A new test confirming that the `$` escaping invariant is preserved still passes (existing test already covers this — confirm it still passes)
- [ ] Behavior is identical for all currently-used keys (`SENDER_NAME`, `BEFORE_MESSAGES`, etc.)

## Tests

Add to `src/prompts.test.ts` inside the existing `describe('fillTemplate')` block:

```typescript
it('key containing regex metacharacters does not throw and substitutes correctly', () => {
  // This would have caused a SyntaxError with the old new RegExp approach
  // because { and } are regex quantifier syntax.
  // (Currently all keys are safe strings, but this guards future callers.)
  const weirdKey = 'A.B[C](D)*';
  const template = `{${weirdKey}}`;
  // split/join approach: the literal string {A.B[C](D)*} must be replaced
  expect(fillTemplate(template, { [weirdKey]: 'VALUE' })).toBe('VALUE');
});

it('key with backslash does not corrupt output', () => {
  const key = 'KEY\\SLASH';
  expect(fillTemplate(`{${key}}`, { [key]: 'result' })).toBe('result');
});
```

## Implementation Details

Replace the loop body in `fillTemplate` (currently lines 239-243 in `src/prompts.ts`):

**Before:**
```typescript
for (const key of Object.keys(vars)) {
  const safeValue = vars[key].replace(/\$/g, '$$$$');
  result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), safeValue);
}
```

**After:**
```typescript
for (const key of Object.keys(vars)) {
  // Use split/join instead of RegExp so key characters that are regex
  // metacharacters (., *, +, ?, [, {, (, \, etc.) cannot cause a RegExp
  // SyntaxError or produce wrong matches. Behavior is identical for all
  // currently-used keys (which are safe uppercase_underscore strings).
  //
  // Note: split/join does NOT need the $-escaping workaround that was
  // required by String.prototype.replace, because split/join uses the
  // replacement value literally.
  result = result.split(`{${key}}`).join(vars[key]);
}
```

**Remove the `safeValue` line entirely.** The `$`-in-replacement-string problem (`$&`, `$1`, `$$`) only applies to `String.prototype.replace`. With `split/join`, the replacement string is treated as a literal — no `$` escaping is needed. The existing test `it('fillTemplate handles $ in values without interpreting as back-references', ...)` should still pass because `split/join` is already literal-safe.

Verify the existing `$` test still passes before removing the `safeValue` line. It should: `'Hello a$&b'`, `'$$'`, `'$1 $2 $&'` are all preserved verbatim by `split/join`.

### Why split/join?

- Zero new dependencies
- O(n) per key (same as the RegExp approach for reasonably sized templates)
- Cannot throw `SyntaxError` on any input key string
- The replacement string is always treated literally (no `$` magic)
- Straightforward to audit

### Alternative considered: escapeRegExp helper

An `escapeRegExp(key)` function would also fix the injection, but split/join is simpler and has one fewer moving part.

## Out of Scope

- Do NOT change the public `fillTemplate` signature
- Do NOT change any callers (no behavior change is observable from outside)
- Do NOT add sanitization of template values (that is covered by task-01's `sanitizePushname` for the specific high-risk value)
- Do NOT change any other prompt constants
