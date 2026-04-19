# Task 02: Append JID Hash to Group Slug (V-009)

## Objective

Append a 6-character hex hash of the group JID to the slug produced for newly-registered groups, so that two groups with identical names always get distinct folders regardless of the counter-based collision fallback.

## Target Files

- `src/groups.ts` — modify `ensureGroupFolder` to append the JID hash when writing new entries; `slugifyGroupName` is not changed (the hash is appended at the call site, not inside the slugifier)

## Dependencies

- Depends on: None
- Blocks: Nothing

## Acceptance Criteria

- [ ] New group folders created after this change have a `<slug>-<6hexchars>` format (e.g., `mgz-a3f9c1`)
- [ ] The 6-char suffix is derived from the first 6 hex characters of `sha256(chatJid)`
- [ ] Existing entries already in `.index.json` are preserved exactly as-is (the function reads the index and returns the stored folder if the JID is already registered — no migration of old folder names)
- [ ] The collision counter logic is preserved as the last-resort fallback if by some astronomical chance the hash+slug also collides (this is now extremely unlikely but keep the loop for correctness)
- [ ] `slugifyGroupName` signature and behavior are unchanged
- [ ] All existing `groups.test.ts` tests still pass (the new folder format is visible only in new-entry tests)
- [ ] New tests pass (see Tests section)

## Tests

Add to `src/groups.test.ts` inside a new `describe('ensureGroupFolder — jid hash suffix')` block:

```typescript
describe('ensureGroupFolder — jid hash suffix', () => {
  it('new group folder includes 6-char hex suffix derived from JID', () => {
    const folder = ensureGroupFolder('120363123456789@g.us', 'mgz');
    // folder should be "mgz-<6hex>"
    expect(folder).toMatch(/^mgz-[0-9a-f]{6}$/);
  });

  it('two groups with identical names get different folders due to JID hash', () => {
    const f1 = ensureGroupFolder('111111111111111@g.us', 'mgz');
    const f2 = ensureGroupFolder('222222222222222@g.us', 'mgz');
    expect(f1).not.toBe(f2);
    // both should be "mgz-<6hex>" but different suffixes
    expect(f1).toMatch(/^mgz-[0-9a-f]{6}$/);
    expect(f2).toMatch(/^mgz-[0-9a-f]{6}$/);
  });

  it('same JID called twice returns same folder (cached in index)', () => {
    const f1 = ensureGroupFolder('111111111111111@g.us', 'mgz');
    const f2 = ensureGroupFolder('111111111111111@g.us', 'different name');
    expect(f1).toBe(f2);
  });

  it('existing index entries from before this change are not migrated', () => {
    // Pre-populate index with an entry in the OLD format (no hash)
    saveGroupIndex({ 'old-group@g.us': { name: 'legacy', folder: 'legacy' } });
    const folder = ensureGroupFolder('old-group@g.us', 'legacy');
    expect(folder).toBe('legacy'); // returned as-is, NOT renamed
  });

  it('hash is deterministic: same JID always produces same 6 chars', () => {
    const jid = '120363999888777@g.us';
    const f1 = ensureGroupFolder(jid, 'alpha');
    // Wipe the index to simulate a second bot instance
    saveGroupIndex({});
    const f2 = ensureGroupFolder(jid, 'alpha');
    expect(f1).toBe(f2);
  });
});
```

## Implementation Details

### src/groups.ts — `ensureGroupFolder` change

Add a `crypto` import at the top of the file:
```typescript
import crypto from 'crypto';
```

Add a private helper (after the `slugifyGroupName` function, before `loadGroupIndex`):
```typescript
/** Returns the first 6 hex characters of sha256(jid). */
function jidHash6(jid: string): string {
  return crypto.createHash('sha256').update(jid).digest('hex').slice(0, 6);
}
```

In `ensureGroupFolder`, change the base slug construction from:
```typescript
const baseSlug = slugifyGroupName(chatName, jidUserPart);
```
to:
```typescript
const slugBase = slugifyGroupName(chatName, jidUserPart);
const baseSlug = `${slugBase}-${jidHash6(chatJid)}`;
```

The rest of the collision loop is unchanged:
```typescript
let candidate = baseSlug;
let counter = 2;
while (usedFolders.has(candidate)) {
  candidate = `${baseSlug}-${counter}`;
  counter++;
}
```

The fallback used by `slugifyGroupName` (when the name normalizes to empty) is still the JID user-part. The JID hash suffix is appended after that fallback is applied, so even groups with emoji-only names get a deterministic hash-qualified folder name.

### Why not change slugifyGroupName?

`slugifyGroupName` is a pure name-to-slug transformer that does not know about JIDs. Keeping the hash appendage in `ensureGroupFolder` (where the JID is available) maintains clean separation of concerns and avoids changing the function's signature, which would require updating all its test cases and any external callers.

## Out of Scope

- Do NOT migrate existing `.index.json` entries to the new format — that would break existing data layouts
- Do NOT change `slugifyGroupName`
- Do NOT change `RUNTIME_PROMPT` references to `{GROUP_FOLDER}` — the variable value comes from `ensureGroupFolder` and is correct at runtime
- Do NOT add input validation or path.resolve containment to `commands.ts` (V-003 skipped)

## Notes

**Severity context (from audit):** The original report's cross-contamination scenario requires two groups with *identical* slugs where `ensureGroupFolder` has only been called for one. The counter-based fallback already prevents two live entries from having the same folder; the hash makes this true even across bot restarts and fresh index files (e.g., if `.index.json` were deleted). Severity is low but the fix is a two-line change with minimal risk.

**Existing data:** Any groups already registered (entries already in `.index.json`) keep their old folder names forever. The `if (idx[chatJid]) return idx[chatJid].folder` early-return handles this correctly with no code change needed.
