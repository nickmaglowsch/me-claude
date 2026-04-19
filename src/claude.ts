import { spawn } from 'child_process';
import { logEvent } from './events';

// Exported for testing — tests can mutate these properties to swap the binary
export const _config = {
  command: 'claude',
  args: [] as string[],
  timeoutMs: 60000,
  toolTimeoutMs: 180000,
};

function runClaude(
  prompt: string,
  extraArgs: string[],
  timeoutMs: number,
  cwd?: string,
  variant?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const startMs = Date.now();
    const child = spawn(_config.command, [..._config.args, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });

    // Always pipe prompt via stdin
    child.stdin.write(prompt);
    child.stdin.end();

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      const durationMs = Date.now() - startMs;
      logEvent({ kind: 'error', reason: `claude CLI timed out after ${timeoutMs / 1000}s`, duration_ms: durationMs, variant });
      reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return; // already rejected
      const durationMs = Date.now() - startMs;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        logEvent({ kind: 'error', reason: `claude CLI exited with code ${code}`, duration_ms: durationMs, variant });
        reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
      } else {
        logEvent({ kind: 'claude.call', duration_ms: durationMs, variant });
        const stdout = Buffer.concat(stdoutChunks).toString();
        resolve(stdout.trim());
      }
    });
  });
}

// Plain prompt → response. No tools. Used by setup and bootstrap where
// we want a deterministic text-in / text-out transformation.
export async function callClaude(
  prompt: string,
  opts?: { model?: string },
): Promise<string> {
  const extraArgs: string[] = [];
  if (opts?.model) {
    extraArgs.push('--model', opts.model);
  }
  return runClaude(prompt, extraArgs, _config.timeoutMs, undefined, 'no-tools');
}

// Prompt → response with tool access enabled. Claude may Read, Edit, Write,
// Grep, and Glob files within `cwd` plus any directories passed via `addDirs`.
// Permissions are bypassed so the subprocess runs non-interactively.
//
// SECURITY BOUNDARY (V-001):
// The subprocess is NOT sandboxed at the OS level. The containment relies on
// the Claude CLI honoring `cwd` for tool path resolution and on the sandbox
// directory (created by src/sandbox.ts) containing only symlinks to the
// files Claude legitimately needs. `--add-dir` is passed as defense-in-depth
// so if `bypassPermissions` is ever tightened, the explicit allow-list
// already reflects the intended scope. Callers MUST pass a dedicated sandbox
// `cwd`; the default (process.cwd()) is used only by tests.
export async function callClaudeWithTools(
  prompt: string,
  cwd: string = process.cwd(),
  addDirs: string[] = [],
): Promise<string> {
  const toolArgs = [
    '--allowed-tools',
    'Read,Edit,Write,Grep,Glob',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'text',
  ];
  for (const dir of addDirs) {
    toolArgs.push('--add-dir', dir);
  }
  return runClaude(prompt, toolArgs, _config.toolTimeoutMs, cwd, 'with-tools');
}
