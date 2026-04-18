import { describe, it, expect, beforeEach } from 'vitest';
import { callClaude, _config } from './claude';

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
