# Task 03: Claude Subprocess Wrapper

## Objective
Create `src/claude.ts` — a thin wrapper that spawns the `claude` CLI binary, pipes the prompt via stdin, enforces a 60-second timeout, and returns stdout as a trimmed string.

## Context

**Quick Context:**
- `claude` CLI is an external binary on PATH — not an npm package
- Prompt is ALWAYS delivered via stdin (never as a CLI argument)
- See `tasks/main/shared-context.md` for test infrastructure

## Requirements

### `src/claude.ts`

Export one function:

```typescript
export async function callClaude(prompt: string): Promise<string>
```

**Behavior:**

1. Spawn a child process using Node's `child_process.spawn`:
   - Command: `"claude"`
   - Args: `[]` (no `-p` flag; stdin carries the prompt)
   - Options: `{ stdio: ["pipe", "pipe", "pipe"] }`

2. **Always pipe the prompt via stdin** — no conditional logic, no arg threshold:
   ```typescript
   child.stdin.write(prompt);
   child.stdin.end();
   ```

3. Collect stdout chunks into a buffer; collect stderr chunks separately.

4. Enforce a 60-second timeout:
   - Use `setTimeout` to call `child.kill()` after 60,000 ms
   - If the timeout fires, reject the returned Promise with an error: `"claude CLI timed out after 60s"`
   - Clear the timeout if the process exits normally

5. On process `close` event:
   - Clear the timeout
   - If exit code is non-zero: reject with an error message that includes the exit code and stderr content
   - If exit code is 0: resolve with `stdout.trim()`

6. Return type is `Promise<string>`.

### Error messages (exact format expected by tests)
- Timeout: `"claude CLI timed out after 60s"`
- Non-zero exit: `"claude CLI exited with code <N>: <stderr content>"`

### `src/claude.test.ts`

Tests use a **fake command** in place of the real `claude` binary. Extract the spawn command into an exported module-level variable that tests can override:

```typescript
// In claude.ts — exported for testing only:
export let _claudeCommand = "claude";
```

Then in tests, set `_claudeCommand` to a known shell command before each test.

**Tests to write:**

1. **Success case**: spawn `node -e "process.stdin.resume(); process.stdin.on('data', d => process.stdout.write(d));"` (an echo via stdin) — assert the resolved value equals the input prompt (trimmed)
2. **Non-zero exit**: spawn a command that exits 1 — assert the Promise rejects with a message containing `"exited with code 1"`
3. **Timeout**: spawn `node -e "setTimeout(() => {}, 999999)"` with the timeout overridden to 100ms — assert the Promise rejects with a message containing `"timed out"`

> Note: These tests spawn real Node.js child processes. They run in < 1s each. No real `claude` binary needed.

## Existing Code References
- `tasks/main/shared-context.md` — tech stack and conventions

## Implementation Details
- Export `_claudeCommand` so tests can swap the binary without mocking `child_process`
- Use `child_process.spawn`, not `exec` or `execFile` — stdin streaming requires spawn
- Collect stdout/stderr via `data` events on `child.stdout` and `child.stderr`
- The timeout `clearTimeout` must happen in the `close` handler before checking exit code

## Acceptance Criteria
- [ ] `callClaude(prompt)` always writes prompt to `child.stdin`, never passes prompt as CLI arg
- [ ] Rejects with `"claude CLI timed out after 60s"` if process runs longer than configured timeout
- [ ] Rejects with `"claude CLI exited with code <N>: ..."` if process exits non-zero
- [ ] Resolves with trimmed stdout string on success
- [ ] `npm test` passes with all tests green
- [ ] TypeScript compiles cleanly

## Dependencies
- Depends on: Task 01 (scaffold)
- Blocks: Task 06 (setup.ts), Task 07 (index.ts)

## TDD Mode

This task uses Test-Driven Development. Write tests BEFORE implementation.

### Test Specifications
- **Test file**: `src/claude.test.ts`
- **Test framework**: Vitest
- **Test command**: `npm test` (runs `vitest run`)

### Tests to Write
1. **Success + stdin delivery**: spawn a real Node.js echo process — resolved value equals the input string
2. **Non-zero exit rejection**: spawn `node -e "process.exit(1)"` — Promise rejects, error message contains `"exited with code 1"`
3. **Timeout rejection**: use an overridable timeout value; spawn a long-running process; set timeout to 100ms — Promise rejects, error message contains `"timed out"`

### TDD Process
1. Write the 3 tests above — they FAIL because `src/claude.ts` does not exist yet (RED)
2. Implement `src/claude.ts` to make them pass (GREEN)
3. Run `npm test` to confirm all green and no regressions in other test files
4. Refactor (error messages, type annotations, code clarity) while keeping green

### Mocking Discipline
- Mock only at the **system boundary**: paid/external APIs, network, wall clock & randomness, destructive side effects, filesystem I/O.
- Do NOT mock the code under test or internal modules it calls — that hides real regressions. Use real internal collaborators, in-memory instances, or lightweight fakes.
- Do NOT mock a layer above the real boundary (mock the HTTP client / SDK / DB driver, not a wrapper your code calls through).
- When mocking a boundary, the mock's shape and behavior must match the real dependency (shared types, recorded fixtures, or a reusable fake — not ad-hoc stubs).

> The system boundary here is the `claude` CLI binary. Tests substitute it with real Node.js child processes (not mocks of `child_process` itself). This gives real subprocess lifecycle coverage without requiring the actual Claude binary.
