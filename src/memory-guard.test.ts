import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { guardedWriteContactMemory } from './memory-guard';

// Helper: create a temp dir, git init it, set up data/contacts/
function setupTempRepo(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-guard-test-'));
  // Init git repo
  execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });
  // Create .gitignore that ignores data/contacts/ (mirrors real conditions)
  fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'data/contacts/\n', 'utf8');
  execSync('git add .gitignore', { cwd: tmpDir, stdio: 'pipe' });
  execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });
  // Create data/contacts/
  fs.mkdirSync(path.join(tmpDir, 'data', 'contacts'), { recursive: true });
  return tmpDir;
}

function teardownTempRepo(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

describe('guardedWriteContactMemory', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = setupTempRepo();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    teardownTempRepo(tmpDir);
  });

  // 1. Shrinkage rejected
  it('rejects when new content is less than 70% of old content (>200 chars)', async () => {
    const jid = 'test1@c.us';
    const oldContent = 'x'.repeat(1000);
    const newContent = 'x'.repeat(500); // 50%, below threshold
    // Write old file directly
    const filePath = path.join(tmpDir, 'data', 'contacts', `${jid}.md`);
    fs.writeFileSync(filePath, oldContent, 'utf8');

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/shrink/i);
  });

  // 2. Shrinkage allowed for tiny old files
  it('allows shrinkage when old file was under 200 chars', async () => {
    const jid = 'test2@c.us';
    const oldContent = 'x'.repeat(50);
    const newContent = 'x'.repeat(30); // large % shrinkage but old file tiny
    const filePath = path.join(tmpDir, 'data', 'contacts', `${jid}.md`);
    fs.writeFileSync(filePath, oldContent, 'utf8');

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(['written', 'committed']).toContain(result.status);
  });

  // 3. New file accepted (no old file, no shrinkage check)
  it('accepts new content when old file does not exist', async () => {
    const jid = 'newcontact@c.us';
    const newContent = 'This is fresh content for a brand new contact.';

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(['written', 'committed']).toContain(result.status);
  });

  // 4. Missing Identity header rejected
  it('rejects when old file had ## Identity but new content does not', async () => {
    const jid = 'test4@c.us';
    const oldContent = `## Identity\n\nSome info about the person.\n\n## Notes\nMore notes.`;
    const newContent = `Some info about the person.\n\n## Notes\nMore notes here but no Identity header.`;
    const filePath = path.join(tmpDir, 'data', 'contacts', `${jid}.md`);
    fs.writeFileSync(filePath, oldContent, 'utf8');

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/identity/i);
  });

  // 5. Missing header check skipped for new files
  it('accepts new file even if it lacks ## Identity header', async () => {
    const jid = 'newfile@c.us';
    const newContent = 'No identity header here, but that is fine for new files.';

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(['written', 'committed']).toContain(result.status);
  });

  // 6. Empty output rejected
  it('rejects empty string content', async () => {
    const jid = 'test6@c.us';
    const result = await guardedWriteContactMemory(jid, '');
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/empty/i);
  });

  it('rejects whitespace-only content', async () => {
    const jid = 'test6b@c.us';
    const result = await guardedWriteContactMemory(jid, '   \n  \t  ');
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/empty/i);
  });

  // 7. Oversized rejected
  it('rejects content exceeding 8192 chars', async () => {
    const jid = 'test7@c.us';
    const newContent = 'x'.repeat(9000);
    const result = await guardedWriteContactMemory(jid, newContent);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/8kb|exceeds/i);
  });

  // 8. Happy path writes file
  it('writes file to disk on happy path', async () => {
    const jid = 'happypath@c.us';
    const newContent = '## Identity\n\nJohn Doe, a friendly person.\n\n## Notes\nLikes coffee.';
    const filePath = path.join(tmpDir, 'data', 'contacts', `${jid}.md`);

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(['written', 'committed']).toContain(result.status);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);
  });

  // 9. Happy path sha hashes populated
  it('populates newHash always, and previousHash when old file existed', async () => {
    const jid = 'hashtest@c.us';
    const oldContent = '## Identity\n\nOld content here.\n';
    const newContent = '## Identity\n\nNew content here.\n';
    const filePath = path.join(tmpDir, 'data', 'contacts', `${jid}.md`);
    fs.writeFileSync(filePath, oldContent, 'utf8');

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(['written', 'committed']).toContain(result.status);
    expect(result.newHash).toBeTruthy();
    expect(result.previousHash).toBeTruthy();
    expect(result.newHash).not.toBe(result.previousHash);
  });

  it('has null previousHash for new files', async () => {
    const jid = 'newfile2@c.us';
    const newContent = 'Fresh content with no previous file.';

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(['written', 'committed']).toContain(result.status);
    expect(result.newHash).toBeTruthy();
    expect(result.previousHash).toBeUndefined();
  });

  // 10. git add -f used
  it('commits the file successfully using git add -f', async () => {
    const jid = 'gitadd@c.us';
    const newContent = '## Identity\n\nPerson who gets committed.\n';

    const result = await guardedWriteContactMemory(jid, newContent);
    // Should be committed since we're in a valid git repo
    expect(result.status).toBe('committed');

    // Verify it appears in git log (force-added despite gitignore)
    const log = execSync('git log --all --oneline', { cwd: tmpDir }).toString();
    expect(log).toMatch(/memory:/);
  });

  // 11. Git failure is non-fatal
  it('returns written (not rejected) and file still exists when git fails', async () => {
    // Move to a non-git directory to simulate git failure
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
    fs.mkdirSync(path.join(nonGitDir, 'data', 'contacts'), { recursive: true });
    process.chdir(nonGitDir);

    const jid = 'gitfail@c.us';
    const newContent = 'Content that will be written even if git fails.';

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(result.status).toBe('written'); // not 'rejected', not 'committed'

    const filePath = path.join(nonGitDir, 'data', 'contacts', `${jid}.md`);
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(newContent);

    // Cleanup
    process.chdir(originalCwd);
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    // Re-setup so afterEach cleanup doesn't fail
    process.chdir(tmpDir);
  });

  // 12. Commit subject for new file
  it('uses "memory: create" in commit message for new files', async () => {
    const jid = 'newfile3@c.us';
    const newContent = 'Fresh new contact memory.';

    const result = await guardedWriteContactMemory(jid, newContent);
    expect(result.status).toBe('committed');

    const log = execSync('git log --all --format=%s', { cwd: tmpDir }).toString();
    expect(log).toMatch(/memory: create/);
  });

  // 13. Commit subject for update
  it('uses "memory: update" in commit message for updated files', async () => {
    const jid = 'existing@c.us';
    const oldContent = '## Identity\n\nExisting person.\n';
    const filePath = path.join(tmpDir, 'data', 'contacts', `${jid}.md`);
    fs.writeFileSync(filePath, oldContent, 'utf8');
    // Force-add and commit old file first
    execSync(`git add -f "data/contacts/${jid}.md"`, { cwd: tmpDir, stdio: 'pipe' });
    execSync('git commit -m "add initial"', { cwd: tmpDir, stdio: 'pipe' });

    const newContent = '## Identity\n\nExisting person with updated info.\n';
    const result = await guardedWriteContactMemory(jid, newContent, { reason: 'update test' });
    expect(result.status).toBe('committed');

    const log = execSync('git log --all --format=%s', { cwd: tmpDir }).toString();
    expect(log).toMatch(/memory: update/);
  });
});
