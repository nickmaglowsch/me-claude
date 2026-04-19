import { describe, it, expect } from 'vitest';
import { selectBurstWindow, extractQuotedAnchor, type ContextMessage } from './context';

// All timestamps are unix seconds (WhatsApp's native unit).
const SEC = 1;
const MIN = 60 * SEC;

function mk(id: string, tsSec: number, body = ''): ContextMessage {
  return { id, timestamp: tsSec, body };
}

describe('selectBurstWindow', () => {
  const base = 1_700_000_000; // arbitrary unix-sec epoch

  it('returns empty before/after when messages pool is empty', () => {
    const trigger = mk('t', base);
    const out = selectBurstWindow([], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before).toEqual([]);
    expect(out.after).toEqual([]);
  });

  it('excludes the trigger message itself from before and after', () => {
    const trigger = mk('t', base);
    const m1 = mk('m1', base - 1 * MIN);
    const m2 = mk('m2', base + 1 * MIN);
    const out = selectBurstWindow([m1, trigger, m2], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before.map(m => m.id)).toEqual(['m1']);
    expect(out.after.map(m => m.id)).toEqual(['m2']);
  });

  it('includes all contiguous messages within burst gap', () => {
    // All 1 minute apart — within the 5-minute gap — so everything is in the burst.
    const msgs = [
      mk('b3', base - 3 * MIN),
      mk('b2', base - 2 * MIN),
      mk('b1', base - 1 * MIN),
      mk('a1', base + 1 * MIN),
      mk('a2', base + 2 * MIN),
    ];
    const trigger = mk('t', base);
    const out = selectBurstWindow([...msgs, trigger], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before.map(m => m.id)).toEqual(['b3', 'b2', 'b1']);
    expect(out.after.map(m => m.id)).toEqual(['a1', 'a2']);
  });

  it('cuts off before context at the first gap larger than burstGapSec', () => {
    // b1 is 1 min before; b2 is 10 min before b1 → cut off at b1
    const trigger = mk('t', base);
    const b1 = mk('b1', base - 1 * MIN);
    const b2 = mk('b2', base - 11 * MIN);
    const b3 = mk('b3', base - 12 * MIN);
    const out = selectBurstWindow([b3, b2, b1, trigger], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before.map(m => m.id)).toEqual(['b1']);
  });

  it('cuts off after context at the first gap larger than burstGapSec', () => {
    const trigger = mk('t', base);
    const a1 = mk('a1', base + 1 * MIN);
    const a2 = mk('a2', base + 11 * MIN); // 10 min gap from a1
    const out = selectBurstWindow([trigger, a1, a2], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.after.map(m => m.id)).toEqual(['a1']);
  });

  it('caps before at maxBefore even when all messages are in the burst', () => {
    const trigger = mk('t', base);
    // 20 messages, each 1 min apart before trigger
    const msgs = Array.from({ length: 20 }, (_, i) =>
      mk(`b${i}`, base - (20 - i) * MIN)
    );
    const out = selectBurstWindow([...msgs, trigger], trigger, {
      burstGapSec: 60 * MIN, // plenty
      maxBefore: 5,
      maxAfter: 10,
    });
    expect(out.before).toHaveLength(5);
    // Keep the 5 MOST RECENT before-messages (closest to trigger)
    expect(out.before.map(m => m.id)).toEqual(['b15', 'b16', 'b17', 'b18', 'b19']);
  });

  it('caps after at maxAfter', () => {
    const trigger = mk('t', base);
    const msgs = Array.from({ length: 20 }, (_, i) =>
      mk(`a${i}`, base + (i + 1) * MIN)
    );
    const out = selectBurstWindow([trigger, ...msgs], trigger, {
      burstGapSec: 60 * MIN,
      maxBefore: 10,
      maxAfter: 3,
    });
    expect(out.after).toHaveLength(3);
    expect(out.after.map(m => m.id)).toEqual(['a0', 'a1', 'a2']);
  });

  it('returns messages in chronological order even if input is unsorted', () => {
    const trigger = mk('t', base);
    const b1 = mk('b1', base - 1 * MIN);
    const b2 = mk('b2', base - 2 * MIN);
    const a1 = mk('a1', base + 1 * MIN);
    // Input deliberately shuffled
    const out = selectBurstWindow([a1, b1, trigger, b2], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before.map(m => m.id)).toEqual(['b2', 'b1']);
    expect(out.after.map(m => m.id)).toEqual(['a1']);
  });

  it('deduplicates messages by id (fetch merges can overlap)', () => {
    const trigger = mk('t', base);
    const b1 = mk('b1', base - 1 * MIN);
    const b1dup = mk('b1', base - 1 * MIN, 'dup');
    const out = selectBurstWindow([b1, b1dup, trigger], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before).toHaveLength(1);
  });

  it('honours minBefore floor when the most recent message is older than burstGapSec', () => {
    // 20-minute silence before the trigger, no burst. Without the floor
    // Claude gets zero context. With minBefore=3 we give it the 3 most
    // recent pre-trigger messages even though they're "outside" the burst.
    const trigger = mk('t', base);
    const b1 = mk('b1', base - 20 * MIN);
    const b2 = mk('b2', base - 21 * MIN);
    const b3 = mk('b3', base - 22 * MIN);
    const b4 = mk('b4', base - 23 * MIN);
    const out = selectBurstWindow([b4, b3, b2, b1, trigger], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
      minBefore: 3,
    });
    expect(out.before.map(m => m.id)).toEqual(['b3', 'b2', 'b1']);
  });

  it('returns empty before/after when the trigger timestamp is not a finite number', () => {
    const trigger: ContextMessage = { id: 't', timestamp: NaN, body: '' };
    const m1 = mk('m1', base);
    const out = selectBurstWindow([m1], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before).toEqual([]);
    expect(out.after).toEqual([]);
  });

  it('stops at the first gap, not later gaps, in the BEFORE walk', () => {
    const trigger = mk('t', base);
    const b1 = mk('b1', base - 1 * MIN);
    const b2 = mk('b2', base - 10 * MIN); // first gap: 9 min (>5) — stops here
    const b3 = mk('b3', base - 11 * MIN);
    const out = selectBurstWindow([b3, b2, b1, trigger], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before.map(m => m.id)).toEqual(['b1']);
  });

  it('treats a gap exactly equal to burstGapSec as still within the burst', () => {
    const trigger = mk('t', base);
    const b1 = mk('b1', base - 5 * MIN); // exactly at the boundary
    const out = selectBurstWindow([b1, trigger], trigger, {
      burstGapSec: 5 * MIN,
      maxBefore: 10,
      maxAfter: 10,
    });
    expect(out.before.map(m => m.id)).toEqual(['b1']);
  });
});

describe('extractQuotedAnchor', () => {
  const base = 1_700_000_000;

  it('returns null when there is no quoted message', () => {
    const result = extractQuotedAnchor(null, { windowIds: new Set(['a', 'b']) });
    expect(result).toBeNull();
  });

  it('returns null when the quoted message is already inside the burst window', () => {
    const quoted = mk('q', base - 2 * MIN);
    const result = extractQuotedAnchor(quoted, {
      windowIds: new Set(['q', 'other']),
    });
    expect(result).toBeNull();
  });

  it('returns the quoted message when it is outside the burst window', () => {
    const quoted = mk('q', base - 60 * MIN, 'hello from the past');
    const result = extractQuotedAnchor(quoted, {
      windowIds: new Set(['other']),
    });
    expect(result).toEqual(quoted);
  });

  it('returns null when passed undefined (defensive)', () => {
    const result = extractQuotedAnchor(undefined, { windowIds: new Set() });
    expect(result).toBeNull();
  });
});
