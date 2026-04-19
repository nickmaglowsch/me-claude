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
      SENDER_NAME: 'Alice',
      SENDER_JID: '5511987654321@c.us',
      TODAY: '2026-04-18',
      QUOTED_BLOCK: '',
      BEFORE_MESSAGES: 'b',
      MENTION_MESSAGE: 'm',
      AFTER_MESSAGES: 'a',
      GROUP_FOLDER: 'some-group',
    });
    expect(result).not.toMatch(/\{[A-Z_]+\}/);
  });

  it('RUNTIME_PROMPT renders a QUOTED block when provided', () => {
    const result = fillTemplate(RUNTIME_PROMPT, {
      VOICE_PROFILE_GOES_HERE: 'v',
      SENDER_NAME: 'Alice',
      SENDER_JID: '5511987654321@c.us',
      TODAY: '2026-04-18',
      QUOTED_BLOCK: 'QUOTED (older message being replied to):\n[09:12] Bob: hi\n\n',
      BEFORE_MESSAGES: 'b',
      MENTION_MESSAGE: 'm',
      AFTER_MESSAGES: 'a',
      GROUP_FOLDER: 'some-group',
    });
    expect(result).toContain('QUOTED (older message being replied to):');
    expect(result).toContain('[09:12] Bob: hi');
  });

  it('RUNTIME_PROMPT references the archive path', () => {
    expect(RUNTIME_PROMPT).toContain('data/groups/');
    expect(RUNTIME_PROMPT).toContain('{GROUP_FOLDER}');
  });

  it('RUNTIME_PROMPT contains SENDER_JID and tool instructions', () => {
    expect(RUNTIME_PROMPT).toContain('{SENDER_JID}');
    expect(RUNTIME_PROMPT).toContain('data/contacts/');
    expect(RUNTIME_PROMPT).toContain('Read');
    expect(RUNTIME_PROMPT).toContain('Edit');
  });

  it('fillTemplate handles $ in values without interpreting as back-references', () => {
    expect(fillTemplate('Hello {X}', { X: 'a$&b' })).toBe('Hello a$&b');
    expect(fillTemplate('{X}', { X: '$$' })).toBe('$$');
    expect(fillTemplate('{X}', { X: '$1 $2 $&' })).toBe('$1 $2 $&');
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

  // --- safety-net: $ escape ---------------------------------------------------
  // These lock in the current $ escaping behavior so the task-03 refactor
  // (RegExp → split/join) can be validated against them.

  it('value containing $1 appears literally in output — not as regex back-reference', () => {
    expect(fillTemplate('{BODY}', { BODY: 'a$1b' })).toBe('a$1b');
  });

  it('value containing $$ appears as two literal dollar signs', () => {
    expect(fillTemplate('{BODY}', { BODY: '$$' })).toBe('$$');
  });

  it('value with mixed back-reference-like sequences appears literally', () => {
    expect(fillTemplate('result: {V}', { V: '$` $\' $0 $1 $&' })).toBe("result: $` $' $0 $1 $&");
  });

  // --- safety-net: empty value ------------------------------------------------
  it('empty string value replaces placeholder with empty string', () => {
    expect(fillTemplate('hello {NAME} world', { NAME: '' })).toBe('hello  world');
  });

  // --- safety-net: repeated placeholder with $ value -------------------------
  it('repeated placeholder with $ value: all occurrences replaced with literal $', () => {
    expect(fillTemplate('{X} and {X}', { X: '$1' })).toBe('$1 and $1');
  });

  // --- safety-net: key with no matching placeholder is silently ignored -------
  it('extra key in vars with no corresponding placeholder is ignored', () => {
    expect(fillTemplate('hello', { UNUSED: 'something' })).toBe('hello');
  });

  // --- safety-net: regex metacharacters in key --------------------------------
  it('key containing regex metacharacters does not throw and substitutes correctly', () => {
    // This would have caused a SyntaxError with the old new RegExp approach
    // because { and } are regex quantifier syntax.
    // (Currently all keys are safe strings, but this guards future callers.)
    const weirdKey = 'A.B[C](D)*';
    const template = `{${weirdKey}}`;
    // split/join approach: the literal string {A.B[C](D)*} must be replaced
    expect(fillTemplate(template, { [weirdKey]: 'VALUE' })).toBe('VALUE');
  });

  it('key with backslash does not corrupt output', () => {
    const key = 'KEY\\SLASH';
    expect(fillTemplate(`{${key}}`, { [key]: 'result' })).toBe('result');
  });
});

describe('RUNTIME_PROMPT delimiters', () => {
  it('RUNTIME_PROMPT contains XML delimiters around all user-controlled blocks', () => {
    expect(RUNTIME_PROMPT).toContain('<sender_name>');
    expect(RUNTIME_PROMPT).toContain('</sender_name>');
    expect(RUNTIME_PROMPT).toContain('<before_messages>');
    expect(RUNTIME_PROMPT).toContain('</before_messages>');
    expect(RUNTIME_PROMPT).toContain('<after_messages>');
    expect(RUNTIME_PROMPT).toContain('</after_messages>');
    expect(RUNTIME_PROMPT).toContain('<mention_message>');
    expect(RUNTIME_PROMPT).toContain('</mention_message>');
  });

  it('new-contact memory template uses a plain H1, not an XML-wrapped name', () => {
    // Pushname is already sanitized (src/sandbox.ts sanitizePushname), so the H1
    // does not need a delimiter; wrapping would leak literal tags into the
    // persisted memory file when Claude copies the template.
    expect(RUNTIME_PROMPT).toContain('# {SENDER_NAME}');
    expect(RUNTIME_PROMPT).not.toContain('# <sender_name>');
  });
});
