import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { callClaude, callClaudeWithTools, _config } from './claude';

describe('callClaude', () => {
  let originalCommand: string;
  let originalArgs: string[];
  let originalTimeoutMs: number;

  beforeEach(() => {
    // Reset to default between tests
    originalCommand = _config.command;
    originalArgs = [..._config.args];
    originalTimeoutMs = _config.timeoutMs;
    _config.command = 'node';
    _config.args = [];
    _config.timeoutMs = 60000;
  });

  afterEach(() => {
    _config.command = originalCommand;
    _config.args = originalArgs;
    _config.timeoutMs = originalTimeoutMs;
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

  // Task 02: model option
  it('callClaude passes --model <name> when model option is provided', async () => {
    // Use a script file so extra args (--model ...) land in process.argv, not node flags
    const os = await import('os');
    const fsm = await import('fs');
    const pathm = await import('path');
    const scriptPath = pathm.join(os.tmpdir(), 'claude-model-test.mjs');
    fsm.writeFileSync(
      scriptPath,
      "process.stdin.resume(); process.stdin.on('data', () => process.stdout.write(process.argv.join(' ')));\n",
      'utf8',
    );
    _config.args = [scriptPath];
    try {
      const result = await callClaude('test', { model: 'claude-haiku-4-5' });
      expect(result).toContain('--model');
      expect(result).toContain('claude-haiku-4-5');
    } finally {
      fsm.unlinkSync(scriptPath);
    }
  });

  it('callClaude uses no --model flag when no model option is provided', async () => {
    const os = await import('os');
    const fsm = await import('fs');
    const pathm = await import('path');
    const scriptPath = pathm.join(os.tmpdir(), 'claude-nomodel-test.mjs');
    fsm.writeFileSync(
      scriptPath,
      "process.stdin.resume(); process.stdin.on('data', () => process.stdout.write(process.argv.join(' ')));\n",
      'utf8',
    );
    _config.args = [scriptPath];
    try {
      const result = await callClaude('test');
      expect(result).not.toContain('--model');
    } finally {
      fsm.unlinkSync(scriptPath);
    }
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
