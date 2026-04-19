# Task 05: Unpredictable Tmp File Names for Atomic Writes (V-012)

## Objective

Replace the predictable `${pid}-${Date.now()}` suffix in atomic write temp file paths with `crypto.randomBytes(8).toString('hex')`, and open the temp file with `O_EXCL` where feasible to eliminate any theoretical symlink-race window.

## Target Files

- `src/memory.ts` — `writeContactMemory`: line 43, the `tmpPath` construction
- `src/ambient.ts` — `saveAmbientConfig`: line 58, the `tmpPath` construction
- `src/memory-guard.ts` — `atomicWrite` helper: line 44, the `tmpPath` construction
- `src/groups.ts` — `saveGroupIndex`: line 118, the `tmpPath` construction

## Dependencies

- Depends on: None
- Blocks: Nothing

## Acceptance Criteria

- [ ] All four `tmpPath` constructions use `crypto.randomBytes(8).toString('hex')` instead of `${process.pid}-${Date.now()}`
- [ ] The `crypto` module is imported in every file that uses it (memory-guard already imports it; groups.ts, ambient.ts, and memory.ts need the import added)
- [ ] Where the platform supports it, the temp file is opened with `O_EXCL | O_CREAT` (exclusive create) to ensure no pre-existing file at that path can be overwritten; fall back to `writeFileSync` if `openSync` with `O_EXCL` throws `EEXIST` (retry with a new random name, max 3 retries)
- [ ] All existing tests still pass
- [ ] New concurrent-write test passes (see Tests section)

## Tests

Add `src/atomic-write.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test the actual write functions to ensure concurrent invocations use
// distinct tmp file names and both writes complete successfully.

import { writeContactMemory } from './memory';
import { saveAmbientConfig, defaultAmbientConfig } from './ambient';
import { saveGroupIndex } from './groups';

let tmpDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'));
  process.chdir(tmpDir);
  // Create required dirs
  fs.mkdirSync(path.join(tmpDir, 'data', 'contacts'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'data', 'groups'), { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('concurrent atomic writes — tmp file name uniqueness', () => {
  it('two concurrent writeContactMemory calls both succeed with distinct tmp names', async () => {
    // Intercept tmp file creation to capture names used
    const tmpNames: string[] = [];
    const origWriteFile = fs.writeFileSync.bind(fs);
    // We cannot easily intercept the O_EXCL open without patching fs, so instead
    // we confirm that two concurrent writes both land correctly (no EEXIST crash,
    // no data corruption).
    const p1 = Promise.resolve().then(() => writeContactMemory('5511@c.us', '# Alice\nContent A'));
    const p2 = Promise.resolve().then(() => writeContactMemory('5511@c.us', '# Alice\nContent B'));
    const [, ] = await Promise.all([p1, p2]);

    // One of the two writes will win the rename race. The final file must be
    // either Content A or Content B — not empty and not corrupted.
    const finalContent = fs.readFileSync(
      path.join(tmpDir, 'data', 'contacts', '5511@c.us.md'),
      'utf8',
    );
    expect(['# Alice\nContent A', '# Alice\nContent B']).toContain(finalContent);
  });

  it('two concurrent saveAmbientConfig calls both succeed', async () => {
    const cfg = defaultAmbientConfig();
    const p1 = Promise.resolve().then(() => saveAmbientConfig({ ...cfg, dailyCap: 10 }));
    const p2 = Promise.resolve().then(() => saveAmbientConfig({ ...cfg, dailyCap: 20 }));
    await Promise.all([p1, p2]);
    // File must exist and be valid JSON
    const raw = fs.readFileSync(path.join(tmpDir, 'data', 'ambient-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect([10, 20]).toContain(parsed.dailyCap);
  });

  it('no .tmp-* files left behind after write', async () => {
    writeContactMemory('5522@c.us', '# Bob\nTest');
    const leftover = fs.readdirSync(path.join(tmpDir, 'data', 'contacts'))
      .filter(f => f.includes('.tmp-'));
    expect(leftover).toHaveLength(0);
  });
});
```

Note: the existing test `'leaves no .tmp-* files behind after save'` in `groups.test.ts` already covers `saveGroupIndex`. Confirm it still passes after the change.

## Implementation Details

### Pattern to replace in all four locations

**Before (current pattern in all four files):**
```typescript
const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(tmpPath, <content>, 'utf8');
fs.renameSync(tmpPath, finalPath);
```

**After (new pattern):**
```typescript
import crypto from 'crypto'; // add at top of file if not already present

// Inside the write function:
function atomicWriteSafe(finalPath: string, content: string): void {
  const rand = crypto.randomBytes(8).toString('hex');
  const tmpPath = `${finalPath}.tmp-${rand}`;
  // O_EXCL ensures we get a fresh file; 0o600 restricts to owner-only
  const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.writeSync(fd, content, 0, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, finalPath);
}
```

Rather than adding a shared helper module (which would add a new import dependency chain), inline the pattern in each of the four locations, or extract a small `src/atomic.ts` utility if the implementer prefers DRY. A shared `src/atomic.ts` is the preferred approach to avoid repeating the pattern four times.

### Suggested `src/atomic.ts`:

```typescript
import crypto from 'crypto';
import fs from 'fs';

/**
 * Write `content` to `finalPath` atomically using a random tmp file + rename.
 * Uses O_EXCL to prevent clobbering an existing file at the tmp path
 * (symlink-race defense). On EEXIST retry up to `maxRetries` times.
 */
export function atomicWriteFile(
  finalPath: string,
  content: string,
  maxRetries = 3,
): void {
  let lastErr: unknown;
  for (let i = 0; i < maxRetries; i++) {
    const rand = crypto.randomBytes(8).toString('hex');
    const tmpPath = `${finalPath}.tmp-${rand}`;
    try {
      const fd = fs.openSync(
        tmpPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      try {
        fs.writeSync(fd, content, 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, finalPath);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        lastErr = err;
        continue; // retry with new random name
      }
      throw err; // unexpected error — rethrow
    }
  }
  throw lastErr; // exhausted retries
}
```

Then in each of the four files, replace:
```typescript
const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(tmpPath, <content>, 'utf8');
fs.renameSync(tmpPath, finalPath);
```
with:
```typescript
atomicWriteFile(finalPath, <content>);
```

And update their imports to include `atomicWriteFile` from `./atomic`.

### O_NOFOLLOW note

`fs.constants.O_NOFOLLOW` prevents following symlinks on the final `open` call. On Linux this is available; on macOS `O_NOFOLLOW` is defined in `<fcntl.h>` but Node.js does not expose it as `fs.constants.O_NOFOLLOW` on all versions. Since the tmp file is created fresh with `O_EXCL` (guaranteeing it didn't exist before), `O_NOFOLLOW` on the tmp path is redundant — the `O_EXCL` flag already guarantees atomicity against the tmp path. Include `O_NOFOLLOW` only if `fs.constants.O_NOFOLLOW` is defined at runtime:

```typescript
const flags =
  fs.constants.O_WRONLY |
  fs.constants.O_CREAT |
  fs.constants.O_EXCL |
  (fs.constants.O_NOFOLLOW ?? 0);  // O_NOFOLLOW not available on all platforms
```

## Out of Scope

- Do NOT change `data/session/` location (V-005 not in scope)
- Do NOT add file-locking across processes (the rename is atomic on POSIX; that is sufficient)
- Do NOT change any read paths (`readFileSync`, `readContactMemory`, etc.)
- Do NOT add `O_NOFOLLOW` on the `renameSync` call (rename destination is the caller's supplied finalPath — that is trusted)

## Notes

**Severity context (from audit):** This is rated theoretical/low for a single-user local bot. An attacker would need concurrent write access to the same directory. The fix is nonetheless cheap (a one-line change per site, plus optional extraction of a shared helper) and eliminates the pattern entirely. The `O_EXCL` flag provides the additional guarantee that no pre-existing file at the tmp path can be silently overwritten by a concurrent write.

**`memory-guard.ts` already imports `crypto`** — no new import needed there. The other three files (`memory.ts`, `ambient.ts`, `groups.ts`) need `import crypto from 'crypto'` added at the top, or they can import `atomicWriteFile` from the new `./atomic` module instead.
