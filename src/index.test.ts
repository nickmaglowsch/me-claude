import { describe, it, expect } from 'vitest';
import { isMentioned, isRateLimited, recordReply, sleep, pickDispatchMode, looksLikeDeclineNarration } from './index';

describe('isMentioned', () => {
  it('returns true when any ownerId is in mentionedIds', () => {
    expect(isMentioned(['id1', 'id2'], ['id1'])).toBe(true);
  });

  it('returns false when no ownerId is in mentionedIds', () => {
    expect(isMentioned(['id2'], ['id1'])).toBe(false);
  });

  it('returns false when mentionedIds is empty', () => {
    expect(isMentioned([], ['id1'])).toBe(false);
  });

  it('matches @c.us prefix against bare digit form (same prefix)', () => {
    expect(isMentioned(['15551234567@c.us'], ['15551234567'])).toBe(true);
  });

  it('matches @lid when owner list includes the @lid id', () => {
    // @lid and @c.us are unrelated IDs for the same user; we match each independently.
    expect(isMentioned(['100000000000000@lid'], ['15551234567@c.us', '100000000000000@lid'])).toBe(true);
  });

  it('does NOT match @lid against a different @c.us id', () => {
    expect(isMentioned(['100000000000000@lid'], ['15551234567@c.us'])).toBe(false);
  });

  it('accepts object-shaped mentionedIds with _serialized', () => {
    expect(isMentioned([{ _serialized: '15551234567@c.us' }], ['15551234567@c.us'])).toBe(true);
  });

  it('returns false when mentionedIds is not an array', () => {
    expect(isMentioned(undefined, ['id1'])).toBe(false);
    expect(isMentioned(null, ['id1'])).toBe(false);
  });
});

describe('isRateLimited', () => {
  it('returns true when last reply was less than limitMs ago', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    map.set('group1', now - 5000); // 5s ago
    expect(isRateLimited(map, 'group1', now, 10000)).toBe(true);
  });

  it('returns false when last reply was more than limitMs ago', () => {
    const map = new Map<string, number>();
    const now = Date.now();
    map.set('group1', now - 15000); // 15s ago
    expect(isRateLimited(map, 'group1', now, 10000)).toBe(false);
  });

  it('returns false when there is no entry for the group', () => {
    const map = new Map<string, number>();
    expect(isRateLimited(map, 'group1', Date.now(), 10000)).toBe(false);
  });
});

describe('recordReply', () => {
  it('sets the timestamp in the map for the given group JID', () => {
    const map = new Map<string, number>();
    recordReply(map, 'group1', 12345);
    expect(map.get('group1')).toBe(12345);
  });

  it('overwrites an existing entry with the new timestamp', () => {
    const map = new Map<string, number>();
    map.set('group1', 1000);
    recordReply(map, 'group1', 9999);
    expect(map.get('group1')).toBe(9999);
  });
});

describe('sleep', () => {
  it('resolves after approximately the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });
});

describe('pickDispatchMode', () => {
  it('returns "reply" for mention triggers so the outbound message quotes the mention', () => {
    expect(pickDispatchMode('mention')).toBe('reply');
  });

  it('returns "reply" for reply triggers so threading is preserved', () => {
    expect(pickDispatchMode('reply')).toBe('reply');
  });

  it('returns "send" for ambient triggers so the bot posts to the group without quoting', () => {
    expect(pickDispatchMode('ambient')).toBe('send');
  });
});

describe('looksLikeDeclineNarration', () => {
  it('catches the exact string that leaked to the RepTime group', () => {
    expect(
      looksLikeDeclineNarration(
        "Empty response - this is an ambient trigger in a watch discussion, Kadur wasn't addressing Nick, and there's nothing here that genuinely needs his input.",
      ),
    ).toBe(true);
  });

  it('catches common decline openings', () => {
    expect(looksLikeDeclineNarration('No response needed here.')).toBe(true);
    expect(looksLikeDeclineNarration('No reply — not my conversation')).toBe(true);
    expect(looksLikeDeclineNarration("Not replying, this isn't for me")).toBe(true);
    expect(looksLikeDeclineNarration('Not responding to this')).toBe(true);
    expect(looksLikeDeclineNarration('Staying silent here')).toBe(true);
    expect(looksLikeDeclineNarration("I'll stay silent on this one")).toBe(true);
    expect(looksLikeDeclineNarration("This doesn't warrant a response")).toBe(true);
    expect(looksLikeDeclineNarration("This doesn't need a reply")).toBe(true);
    expect(looksLikeDeclineNarration('Nothing to add')).toBe(true);
    expect(looksLikeDeclineNarration('Nothing worth saying here')).toBe(true);
    expect(looksLikeDeclineNarration('Skipping this one')).toBe(true);
    expect(looksLikeDeclineNarration('Declining to respond')).toBe(true);
  });

  it('is case-insensitive and tolerates curly apostrophes', () => {
    expect(looksLikeDeclineNarration('EMPTY RESPONSE — nothing relevant')).toBe(true);
    expect(looksLikeDeclineNarration('I’ll stay silent')).toBe(true);
    expect(looksLikeDeclineNarration('This doesn’t warrant a response')).toBe(true);
  });

  it('does NOT flag legitimate replies that happen to contain similar words later', () => {
    expect(
      looksLikeDeclineNarration(
        'haha sim, o noob tem resposta melhor que o VSF nesse caso',
      ),
    ).toBe(false);
    expect(looksLikeDeclineNarration('nothing beats a clean factory sub')).toBe(false);
    expect(
      looksLikeDeclineNarration(
        'eu respondi ontem no grupo, mas vale repetir: o OP chegou em mãos',
      ),
    ).toBe(false);
  });

  it('only matches patterns at the start of the first line', () => {
    // A real reply that ends with "no response needed" somewhere in the middle
    // is still a real reply. Only the opening narration is the tell.
    expect(
      looksLikeDeclineNarration(
        'Acho que esse OP fica bom, no response needed do vendedor ainda',
      ),
    ).toBe(false);
  });

  it('returns false for empty or whitespace-only input', () => {
    expect(looksLikeDeclineNarration('')).toBe(false);
    expect(looksLikeDeclineNarration('   ')).toBe(false);
    expect(looksLikeDeclineNarration('\n\n')).toBe(false);
  });
});
