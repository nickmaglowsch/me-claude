import { describe, it, expect } from 'vitest';
import { isMentioned, isRateLimited, recordReply, sleep } from './index';

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
