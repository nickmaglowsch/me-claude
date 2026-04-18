import { spawn } from 'child_process';

// Exported for testing — tests can mutate these properties to swap the binary
export const _config = {
  command: 'claude',
  args: [] as string[],
  timeoutMs: 60000,
};

export async function callClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(_config.command, _config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
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
      reject(new Error('claude CLI timed out after 60s'));
    }, _config.timeoutMs);

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
