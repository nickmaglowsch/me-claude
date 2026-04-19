import { describe, it, expect, beforeEach } from 'vitest';
import { callClaude, callClaudeWithTools, _config } from './claude';

describe('callClaude', () => {
  beforeEach(() => {
    // Reset to default between tests
    _config.command = 'node';
    _config.args = [];
    _config.timeoutMs = 60000;
  });

  it('success: resolves with stdin-echoed content', async () => {
    _config.args = ['-e', "process.stdin.resume(); process.stdin.on('data', d => process.stdout.write(d));"];
    const result = await callClaude('hello world');
    expect(result).toBe('hello world');
  });

  it('non-zero exit: rejects with code in error message', async () => {
    _config.args = ['-e', 'process.exit(1);'];
    await expect(callClaude('test')).rejects.toThrow('exited with code 1');
  });

  it('timeout: rejects with timed out message', async () => {
    _config.args = ['-e', 'setTimeout(() => {}, 999999);'];
    _config.timeoutMs = 100;
    await expect(callClaude('test')).rejects.toThrow('timed out');
  });
});

describe('callClaudeWithTools', () => {
  beforeEach(() => {
    _config.command = 'node';
    _config.args = [];
    _config.toolTimeoutMs = 60000;
  });

  it('cwd arg is forwarded to spawn', async () => {
    // callClaudeWithTools appends --allowed-tools etc. as extra CLI args; node
    // rejects unknown flags unless they come after '--'. Use a helper script
    // written to a tmp file so the args are treated as argv (ignored) rather
    // than node flags.
    const os = await import('os');
    const fs = await import('fs');
    const path = await import('path');
    const scriptPath = path.join(os.tmpdir(), 'cwd-test-helper.mjs');
    fs.writeFileSync(
      scriptPath,
      // Script ignores argv (the --allowed-tools etc.) and just prints cwd
      "process.stdin.resume(); process.stdin.on('data', () => process.stdout.write(process.cwd()));\n",
      'utf8',
    );
    _config.command = 'node';
    _config.args = [scriptPath];
    const result = await callClaudeWithTools('x', '/tmp');
    fs.unlinkSync(scriptPath);
    expect(result).toBe('/tmp');
  });
});
