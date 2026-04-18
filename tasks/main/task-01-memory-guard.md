# Task 01: Memory Guard (git-versioning + corruption detection)

## Objective

Wrap every write to `data/contacts/*.md` with (a) a corruption guard that
snapshots the file before the write and rejects obviously-bad changes, and
(b) automatic git commits so every memory update is revertable. Makes
memory writes safe under any Claude misbehavior.

## Target Files

- `src/memory-guard.ts` (new)
- `src/memory-guard.test.ts` (new)
- `src/memory.ts` (modify `writeContactMemory` to route through the guard)
- `src/memory-bootstrap.ts` (no changes — uses `writeContactMemory` so inherits guard automatically)

## Context Files

- `tasks/main/shared-context.md`
- `src/memory.ts` — current `writeContactMemory` implementation
- `docs/architecture-improvements.md` — items 1 and 2 specifications

## Dependencies

None. Can run in parallel with task 02.

## Requirements

### 1. `src/memory-guard.ts` — new module

Export a function:

```typescript
export async function guardedWriteContactMemory(
  cusJid: string,
  newContent: string,
  context?: { reason?: string; chatName?: string }
): Promise<GuardResult>;

export interface GuardResult {
  status: 'written' | 'rejected' | 'committed';
  // 'written' — file was written but git commit failed (non-fatal)
  // 'rejected' — change failed the corruption guard; old file kept
  // 'committed' — file written and git-committed successfully
  reason?: string; // populated on 'rejected'
  previousHash?: string; // sha256 of the previous file content (or null if new)
  newHash?: string;      // sha256 of the new content (if written)
}
```

### 2. Corruption guard rules

Reject the write (return `status: 'rejected'`) if ANY of:

- **Shrinkage**: the new content is < 70% the size of the old content
  (i.e. file would shrink by more than 30%). Skip this check if the old
  file didn't exist or was <200 chars (bootstrap/new files are fine).
- **Missing Identity header**: the old file contained `## Identity` on a
  line by itself, but the new content does not. Suggests Claude deleted
  the header section.
- **Empty or whitespace-only output**: new content trims to empty string.
  Return reason `"empty output"`.
- **Too large**: new content is >8192 chars (2× our 4KB target). Reject
  with reason `"exceeds 8KB"` — caller can ask Claude to compact and retry.

When rejecting, log a warning to stdout with the reason, the JID, and the
size delta.

When accepting, proceed to step 3.

### 3. Atomic write

Write via tmp + rename (reuse `writeContactMemory` internals or replicate
the pattern directly). Never call `fs.writeFileSync` on the final path.

### 4. Auto git commit

After a successful atomic write, shell out to git (via child_process) in
the project root:

- `git add data/contacts/<jid>@c.us.md`
- `git commit -m "memory: <short subject>" -m "<body>"` where:
  - Subject: `memory: update <jid>@c.us` (truncate jid to first 15 chars if longer)
    - If this is a NEW file (old content was null): `memory: create <jid>@c.us`
    - If `context.chatName` is set: append ` (from <chatName>)`
  - Body: `Reason: <context.reason or "update">\nPrevious hash: <sha or "none">\nNew hash: <sha>`

Git failures are non-fatal: log a warning (`[memory] git commit failed: ...`),
return `status: 'written'` (not `'committed'`) but the write itself stands.

IMPORTANT: the `data/contacts/` dir is currently gitignored. Do NOT change
the gitignore. Instead, force-add the file with `git add -f` so the
auto-commits work even though the directory is listed in `.gitignore`.
This means: the memory files are versioned but would not be included in a
fresh clone — they're local-only. That's intentional (privacy).

### 5. Integration with `src/memory.ts`

Modify the existing exported `writeContactMemory(cusJid, contents)` to call
the guard internally. Keep the same signature for backwards compatibility;
callers that don't care about the result still work. Add an opt-in
richer signature:

```typescript
export function writeContactMemory(cusJid: string, contents: string): void;
export async function writeContactMemoryGuarded(
  cusJid: string,
  contents: string,
  context?: { reason?: string; chatName?: string }
): Promise<GuardResult>;
```

The simpler `writeContactMemory` can either:
- Just call `guardedWriteContactMemory` and swallow the result (fire-and-forget)
- OR stay as the raw atomic-write and callers that want the guard use the new API

Pick the approach that causes the fewest regressions — document the choice
in the task's Implementation Notes.

### 6. Retry of bootstrap and runtime writes

- `src/memory-bootstrap.ts`: change the `writeContactMemory(cusJid, output)`
  call to `await writeContactMemoryGuarded(cusJid, output, { reason: 'bootstrap' })`.
  Log the result status.
- `src/index.ts`: runtime doesn't call `writeContactMemory` directly anymore
  (Claude's Edit tool does the writing). So this task doesn't affect runtime
  directly — tool-use writes are NOT guarded by this code.

  **Note for runtime memory safety**: since Claude writes directly via the Edit
  tool inside the subprocess, our guard can't wrap those writes. That's fine
  for this task — tool-use writes can be caught with a post-hoc check
  (compare git diff after claude exits). Add a TODO comment in index.ts
  pointing to this limitation. A separate future task can add post-claude
  guard.

## Acceptance Criteria

- [ ] `src/memory-guard.ts` exports `guardedWriteContactMemory` and `writeContactMemoryGuarded`
- [ ] All 4 corruption rules implemented and tested
- [ ] Atomic write via tmp + rename
- [ ] Git commit runs after successful write; failures are non-fatal
- [ ] Files added with `git add -f` to bypass `.gitignore`
- [ ] `src/memory-bootstrap.ts` uses the guarded path
- [ ] Existing tests still pass
- [ ] New tests cover: shrinkage rejection, missing-header rejection, empty rejection, oversized rejection, happy path (write + commit), git-failure recovery
- [ ] `npm run build` exits 0; `npm test` green
- [ ] Runtime `src/index.ts` has a TODO comment noting that Claude tool-use writes bypass this guard

## TDD Mode

### Test file: `src/memory-guard.test.ts`

### Test framework: Vitest

### Tests to write FIRST (RED → GREEN → REFACTOR):

1. **Shrinkage rejected**: old content 1000 chars, new content 500 chars → `status: 'rejected'`, reason contains `shrink`
2. **Shrinkage allowed for tiny old files**: old content 50 chars, new content 30 chars → `status: 'written'` or `'committed'` (tiny threshold bypass)
3. **New file accepted**: old file doesn't exist, new content is reasonable → `status: 'written'` or `'committed'`, no shrinkage check applies
4. **Missing Identity header rejected**: old content contains `## Identity\n`, new content doesn't → `status: 'rejected'`, reason contains `Identity`
5. **Missing header check skipped for new files**: old file didn't exist, new content lacks `## Identity` → accepted (new files start without structure is fine, though ideal bootstrap output always has it)
6. **Empty output rejected**: new content is `""` or `"   \n"` → `status: 'rejected'`, reason `empty`
7. **Oversized rejected**: new content is 9000 chars → `status: 'rejected'`, reason contains `8KB` or `exceeds`
8. **Happy path writes file**: valid new content → file is written to disk with exact bytes
9. **Happy path sha hashes populated**: writes return non-null `previousHash` when old file existed, and always a `newHash`
10. **Git-add-f used**: mock or spy on git commit invocation; verify `add -f` was passed (one way: temp git repo + write + inspect `git log --all`)
11. **Git failure non-fatal**: simulate git failure (e.g. cwd is not a git repo) → `status: 'written'` (NOT rejected), file still exists, warning logged
12. **Commit subject for new file**: new file → commit message starts with `memory: create`
13. **Commit subject for update**: existing file → commit message starts with `memory: update`

### Test isolation

- Create a temp dir with `fs.mkdtemp`, `git init` it, `process.chdir` to it, create `data/contacts/`
- Add the dir to `.gitignore` within the temp dir to mirror real conditions
- Run each test in isolation (beforeEach/afterEach)
- Clean up temp dir after each test

### Mocking discipline

- Do NOT mock `fs`. Use real temp directories.
- Do NOT mock `child_process` git calls. Use real git on a real temp repo.
- If a test needs to simulate git failure, set up a cwd that isn't a git repo.

### Notes for implementer

- The "missing Identity header" rule only fires if the OLD file had the header. Otherwise skip the check.
- Shrinkage threshold: old_len > 200 AND new_len < old_len * 0.7
- Consider that `git commit` on a gitignored-but-force-added file may print warnings; filter stderr so warnings don't spam console.log
- sha256 via `crypto.createHash('sha256').update(content).digest('hex')`
