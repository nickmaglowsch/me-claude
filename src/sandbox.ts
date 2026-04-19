import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Strip characters from a pushname (WhatsApp display name) that could be used
 * for prompt injection:
 *   - carriage returns (\r) and newlines (\n): structural line injection
 *   - backticks (`): Markdown code-block injection
 *   - leading # characters: Markdown heading injection (e.g. "# OVERRIDE")
 * Result is capped at 64 characters.
 */
export function sanitizePushname(raw: string): string {
  return raw
    .replace(/[\r\n`]/g, '')       // strip newlines and backticks
    .replace(/^#+\s*/g, '')         // strip leading markdown heading chars
    .slice(0, 64);                  // cap length
}

/**
 * Create an isolated temporary directory for a single Claude subprocess invocation.
 *
 * Layout:
 *   <sandbox>/
 *     data/
 *       contacts/  → symlink to <projectRoot>/data/contacts/  (Grep/Glob/Read/Write access)
 *       groups/    → symlink to <projectRoot>/data/groups/    (GROUP_FOLDER archive access)
 *     voice_profile.md → symlink to <projectRoot>/data/voice_profile.md
 *
 * V-008 tradeoff: data/contacts/ is exposed via symlink so the Grep instruction
 * in RUNTIME_PROMPT still works (cross-contact lookup is a desired feature, V-008 kept).
 * Writes by Claude resolve through the symlink and land in the real data/contacts/ tree.
 * The sandbox isolates .env, data/session/, src/, and node_modules/ — the high-value targets.
 *
 * @param _senderJid  Unused; reserved for future per-sender sandboxing.
 * @param _groupFolder Unused; reserved for future per-group sandboxing.
 * @param projectRoot  The project root directory (defaults to process.cwd()).
 */
export async function createSandbox(
  _senderJid: string,
  _groupFolder: string,
  projectRoot: string = process.cwd(),
): Promise<string> {
  const id = crypto.randomBytes(8).toString('hex');
  const sandboxDir = path.join(os.tmpdir(), `me-claude-sandbox-${id}`);

  const dataDir = path.join(sandboxDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Symlink data/contacts/ → real contacts dir (Grep + Read + Write land here)
  const realContacts = path.join(projectRoot, 'data', 'contacts');
  fs.mkdirSync(realContacts, { recursive: true });
  fs.symlinkSync(realContacts, path.join(dataDir, 'contacts'));

  // Symlink data/groups/ → real groups dir (for GROUP_FOLDER JSONL archive)
  const realGroups = path.join(projectRoot, 'data', 'groups');
  fs.mkdirSync(realGroups, { recursive: true });
  fs.symlinkSync(realGroups, path.join(dataDir, 'groups'));

  // Symlink voice_profile.md → real voice profile (if it exists)
  const realProfile = path.join(projectRoot, 'data', 'voice_profile.md');
  if (fs.existsSync(realProfile)) {
    fs.symlinkSync(realProfile, path.join(sandboxDir, 'voice_profile.md'));
  }

  return sandboxDir;
}

/**
 * Remove the sandbox directory created by createSandbox.
 * Only removes directories whose path starts with `<os.tmpdir()>/me-claude-sandbox-`
 * as a safety guard against accidental recursive deletes.
 * Symlinks inside are removed along with the directory shell; the real data/ targets are untouched.
 */
export async function destroySandbox(sandboxDir: string): Promise<void> {
  const expectedPrefix = path.join(os.tmpdir(), 'me-claude-sandbox-');
  if (!sandboxDir.startsWith(expectedPrefix)) {
    throw new Error(`destroySandbox: unexpected path ${sandboxDir}`);
  }
  fs.rmSync(sandboxDir, { recursive: true, force: true });
}
