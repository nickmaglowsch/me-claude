import { describe, it, expect } from 'vitest';
import { fillTemplate, META_PROMPT, RUNTIME_PROMPT } from './prompts';

describe('fillTemplate', () => {
  it('single substitution', () => {
    expect(fillTemplate('Hello {NAME}', { NAME: 'World' })).toBe('Hello World');
  });

  it('multiple different keys', () => {
    expect(fillTemplate('{A} and {B}', { A: 'foo', B: 'bar' })).toBe('foo and bar');
  });

  it('repeated placeholder', () => {
    expect(fillTemplate('{X} {X}', { X: 'hi' })).toBe('hi hi');
  });

  it('missing key leaves placeholder untouched', () => {
    expect(fillTemplate('{UNKNOWN}', {})).toBe('{UNKNOWN}');
  });

  it('empty vars returns template unchanged', () => {
    expect(fillTemplate('no placeholders', {})).toBe('no placeholders');
  });

  it('META_PROMPT smoke test — no unfilled MESSAGES_GO_HERE after fill', () => {
    const result = fillTemplate(META_PROMPT, { MESSAGES_GO_HERE: 'hello world' });
    expect(result).not.toContain('{MESSAGES_GO_HERE}');
  });

  it('RUNTIME_PROMPT smoke test — no unfilled placeholders after fill', () => {
    const result = fillTemplate(RUNTIME_PROMPT, {
      VOICE_PROFILE_GOES_HERE: 'v',
      CONTACT_CONTEXT: '',
      BEFORE_MESSAGES: 'b',
      MENTION_MESSAGE: 'm',
      AFTER_MESSAGES: 'a',
    });
    expect(result).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('RUNTIME_PROMPT contains CONTACT_CONTEXT placeholder', () => {
    expect(RUNTIME_PROMPT).toContain('{CONTACT_CONTEXT}');
  });

  it('MEMORY_UPDATE_PROMPT smoke test — no unfilled placeholders after fill', async () => {
    const { MEMORY_UPDATE_PROMPT } = await import('./prompts');
    const result = fillTemplate(MEMORY_UPDATE_PROMPT, {
      CURRENT_MEMORY: 'none',
      CONTACT_NAME: 'Alice',
      CONTACT_JID: '5511987654321@c.us',
      BEFORE_MESSAGES: 'b',
      MENTION_MESSAGE: 'm',
      AFTER_MESSAGES: 'a',
      NICK_REPLY: 'r',
      TODAY: '2026-04-18',
    });
    expect(result).not.toMatch(/\{[A-Z_]+\}/);
  });
});
