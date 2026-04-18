import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export interface GuardResult {
  status: 'written' | 'rejected' | 'committed';
  // 'written'   — file was written but git commit failed (non-fatal)
  // 'rejected'  — change failed the corruption guard; old file kept
  // 'committed' — file written and git-committed successfully
  reason?: string;    // populated on 'rejected'
  previousHash?: string; // sha256 of previous file content (undefined if new)
  newHash?: string;   // sha256 of the new content (if written)
}

// Compute paths dynamically (using process.cwd() at call time) so that tests
// can process.chdir() into a temp directory and get correct paths.
function getContactsDir(): string {
  return path.join(process.cwd(), 'data', 'contacts');
}

function getContactFilePath(cusJid: string): string {
  return path.join(getContactsDir(), `${cusJid}.md`);
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readExisting(cusJid: string): string | null {
  const filePath = getContactFilePath(cusJid);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function atomicWrite(cusJid: string, contents: string): void {
  const contactsDir = getContactsDir();
  fs.mkdirSync(contactsDir, { recursive: true });
  const finalPath = getContactFilePath(cusJid);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, contents, 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

function buildCommitSubject(
  cusJid: string,
  isNew: boolean,
  chatName?: string,
): string {
  const shortJid = cusJid.length > 15 ? cusJid.slice(0, 15) : cusJid;
  const verb = isNew ? 'create' : 'update';
  let subject = `memory: ${verb} ${shortJid}`;
  if (chatName) subject += ` (from ${chatName})`;
  return subject;
}

// Strip characters that could corrupt a commit message (newlines, backticks,
// dollar signs, double-quotes) as defense-in-depth. execFileSync already
// prevents shell injection, but this keeps commit messages well-formed.
const safe = (s: string): string => s.replace(/[\n\r`$"]/g, ' ');

function gitCommit(
  cusJid: string,
  isNew: boolean,
  previousHash: string | undefined,
  newHash: string,
  context?: { reason?: string; chatName?: string },
): void {
  const filePath = path.join('data', 'contacts', `${cusJid}.md`);
  const subject = safe(buildCommitSubject(cusJid, isNew, context?.chatName));
  const body = safe([
    `Reason: ${context?.reason ?? 'update'}`,
    `Previous hash: ${previousHash ?? 'none'}`,
    `New hash: ${newHash}`,
  ].join('\n'));

  const cwd = process.cwd();

  // Force-add bypasses .gitignore so these privacy-sensitive files stay
  // local-only (not in fresh clones) but are versioned for revert safety.
  // Args passed as array to execFileSync — no shell involved, no injection risk.
  execFileSync('git', ['add', '-f', filePath], { cwd, encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', subject, '-m', body], { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/**
 * Write a contact memory file with corruption guard and automatic git versioning.
 *
 * Corruption rules (any match → rejected):
 *   - Empty / whitespace-only content
 *   - Content > 8192 chars
 *   - New content < 70% of old content length (when old > 200 chars)
 *   - Old file had "## Identity" on its own line but new content doesn't
 *
 * On rejection the old file is untouched. On success the file is atomically
 * written and git-committed (git failures are non-fatal: status = 'written').
 */
export async function guardedWriteContactMemory(
  cusJid: string,
  newContent: string,
  context?: { reason?: string; chatName?: string },
): Promise<GuardResult> {
  // --- Rule 1: empty or whitespace-only ---
  if (!newContent.trim()) {
    console.warn(`[memory-guard] rejected ${cusJid}: empty output`);
    return { status: 'rejected', reason: 'empty output' };
  }

  // --- Rule 2: too large ---
  if (newContent.length > 8192) {
    console.warn(
      `[memory-guard] rejected ${cusJid}: exceeds 8KB (${newContent.length} chars)`,
    );
    return { status: 'rejected', reason: 'exceeds 8KB' };
  }

  const oldContent = readExisting(cusJid);
  const isNew = oldContent === null;
  const previousHash = oldContent !== null ? sha256(oldContent) : undefined;

  if (oldContent !== null) {
    const oldLen = oldContent.length;
    const newLen = newContent.length;

    // --- Rule 3: shrinkage ---
    if (oldLen > 200 && newLen < oldLen * 0.7) {
      console.warn(
        `[memory-guard] rejected ${cusJid}: shrinkage ${oldLen} → ${newLen} chars (${Math.round((newLen / oldLen) * 100)}% of original)`,
      );
      return {
        status: 'rejected',
        reason: `shrinkage: ${oldLen} → ${newLen} chars`,
      };
    }

    // --- Rule 4: missing Identity header ---
    const hadIdentity = /^## Identity$/m.test(oldContent);
    const hasIdentity = /^## Identity$/m.test(newContent);
    if (hadIdentity && !hasIdentity) {
      console.warn(
        `[memory-guard] rejected ${cusJid}: ## Identity header was removed`,
      );
      return {
        status: 'rejected',
        reason: 'missing Identity header',
      };
    }
  }

  // All checks passed — atomically write
  atomicWrite(cusJid, newContent);
  const newHash = sha256(newContent);

  // Attempt git commit (non-fatal)
  try {
    gitCommit(cusJid, isNew, previousHash, newHash, context);
    return { status: 'committed', previousHash, newHash };
  } catch (err) {
    console.warn(
      `[memory] git commit failed: ${(err as Error).message.split('\n')[0]}`,
    );
    return { status: 'written', previousHash, newHash };
  }
}

// Alias — same function, alternate export name used by memory.ts and callers
// who prefer the "guarded write" naming convention.
export const writeContactMemoryGuarded = guardedWriteContactMemory;
