import { spawn } from 'child_process';

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
): Promise<string> {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return; // already rejected
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString();
        reject(new Error(`claude CLI exited with code ${code}: ${stderr}`));
      } else {
        const stdout = Buffer.concat(stdoutChunks).toString();
        resolve(stdout.trim());
      }
    });
  });
}

// Plain prompt → response. No tools. Used by setup and bootstrap where
// we want a deterministic text-in / text-out transformation.
export async function callClaude(prompt: string): Promise<string> {
  return runClaude(prompt, [], _config.timeoutMs);
}

// Prompt → response with tool access enabled. Claude may Read, Edit, Write,
// Grep, and Glob files within `cwd` (and any --add-dir paths, but we don't
// add any). Permissions are bypassed so the subprocess runs non-interactively.
//
// Used by the runtime to let Claude fetch + update per-contact memory files
// on its own rather than pre-loading / post-writing them from our code.
export async function callClaudeWithTools(
  prompt: string,
  cwd: string = process.cwd(),
): Promise<string> {
  const toolArgs = [
    '--allowed-tools',
    'Read,Edit,Write,Grep,Glob',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'text',
  ];
  return runClaude(prompt, toolArgs, _config.toolTimeoutMs, cwd);
}
