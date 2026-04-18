import { describe, it, expect } from 'vitest';
import {
  filterMessages,
  stratifiedSampleByChat,
  shuffle,
  checkMinimumVolume,
  formatMessagesForPrompt,
  RawMessage,
} from './extract';

function makeMsg(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    fromMe: true,
    type: 'chat',
    body: 'hello',
    timestamp: 1000,
    ...overrides,
  };
}

describe('filterMessages', () => {
  it('keeps valid chat messages (fromMe=true, type=chat, body>=3 chars)', () => {
    const msgs = [makeMsg({ body: 'hello' })];
    expect(filterMessages(msgs)).toHaveLength(1);
  });

  it('drops messages where fromMe=false', () => {
    const msgs = [makeMsg({ fromMe: false })];
    expect(filterMessages(msgs)).toHaveLength(0);
  });

  it('drops messages where type is not chat', () => {
    const msgs = [makeMsg({ type: 'image' }), makeMsg({ type: 'sticker' })];
    expect(filterMessages(msgs)).toHaveLength(0);
  });

  it('drops messages with body shorter than 3 characters', () => {
    const msgs = [makeMsg({ body: 'hi' }), makeMsg({ body: 'ok' }), makeMsg({ body: 'k' })];
    expect(filterMessages(msgs)).toHaveLength(0);
  });

  it('keeps messages with body exactly 3 characters', () => {
    const msgs = [makeMsg({ body: 'hey' })];
    expect(filterMessages(msgs)).toHaveLength(1);
  });

  it('drops messages with body equal to "<Media omitted>"', () => {
    const msgs = [makeMsg({ body: '<Media omitted>' })];
    expect(filterMessages(msgs)).toHaveLength(0);
  });

  it('keeps numeric-only messages that are 3+ chars', () => {
    const msgs = [makeMsg({ body: '123' }), makeMsg({ body: '12345' })];
    expect(filterMessages(msgs)).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(filterMessages([])).toHaveLength(0);
  });
});

describe('stratifiedSampleByChat', () => {
  it('returns all messages when each chat has fewer than perChatMax', () => {
    const chat1 = [makeMsg({ body: 'a1' }), makeMsg({ body: 'a2' })];
    const chat2 = [makeMsg({ body: 'b1' })];
    expect(stratifiedSampleByChat([chat1, chat2], 50)).toHaveLength(3);
  });

  it('caps at perChatMax per chat', () => {
    const bigChat = Array.from({ length: 100 }, (_, i) => makeMsg({ body: `msg${i}` }));
    const result = stratifiedSampleByChat([bigChat], 50);
    expect(result).toHaveLength(50);
  });

  it('concatenates across multiple chats', () => {
    const chat1 = Array.from({ length: 3 }, (_, i) => makeMsg({ body: `a${i}` }));
    const chat2 = Array.from({ length: 3 }, (_, i) => makeMsg({ body: `b${i}` }));
    expect(stratifiedSampleByChat([chat1, chat2], 10)).toHaveLength(6);
  });

  it('handles empty outer array', () => {
    expect(stratifiedSampleByChat([], 50)).toHaveLength(0);
  });

  it('handles perChatMax=0', () => {
    const chat = [makeMsg()];
    expect(stratifiedSampleByChat([chat], 0)).toHaveLength(0);
  });
});

describe('shuffle', () => {
  it('returns array with same elements (sorted comparison)', () => {
    const msgs = [makeMsg({ body: 'a' }), makeMsg({ body: 'b' }), makeMsg({ body: 'c' })];
    const shuffled = shuffle(msgs);
    expect(shuffled).toHaveLength(msgs.length);
    const sortedOriginal = [...msgs].map(m => m.body).sort();
    const sortedShuffled = [...shuffled].map(m => m.body).sort();
    expect(sortedShuffled).toEqual(sortedOriginal);
  });

  it('does not mutate the original array', () => {
    const msgs = [makeMsg({ body: 'x' }), makeMsg({ body: 'y' })];
    const original = [...msgs];
    shuffle(msgs);
    expect(msgs).toEqual(original);
  });

  it('returns empty array for empty input', () => {
    expect(shuffle([])).toHaveLength(0);
  });
});

describe('checkMinimumVolume', () => {
  it('does not throw when length >= 100', () => {
    const msgs = Array.from({ length: 100 }, () => makeMsg());
    expect(() => checkMinimumVolume(msgs)).not.toThrow();
  });

  it('throws with exact message when length < 100', () => {
    const msgs = Array.from({ length: 50 }, () => makeMsg());
    expect(() => checkMinimumVolume(msgs)).toThrow(
      'Not enough message history to build a reliable voice profile.'
    );
  });

  it('throws on empty array', () => {
    expect(() => checkMinimumVolume([])).toThrow(
      'Not enough message history to build a reliable voice profile.'
    );
  });

  it('throws at 99 items but not at 100', () => {
    const msgs99 = Array.from({ length: 99 }, () => makeMsg());
    const msgs100 = Array.from({ length: 100 }, () => makeMsg());
    expect(() => checkMinimumVolume(msgs99)).toThrow();
    expect(() => checkMinimumVolume(msgs100)).not.toThrow();
  });
});

describe('formatMessagesForPrompt', () => {
  it('formats a single message as its body text', () => {
    const msgs = [makeMsg({ body: 'hello world' })];
    expect(formatMessagesForPrompt(msgs)).toBe('hello world');
  });

  it('joins multiple messages with "\\n---\\n"', () => {
    const msgs = [makeMsg({ body: 'first' }), makeMsg({ body: 'second' })];
    expect(formatMessagesForPrompt(msgs)).toBe('first\n---\nsecond');
  });

  it('returns empty string for empty array', () => {
    expect(formatMessagesForPrompt([])).toBe('');
  });
});
