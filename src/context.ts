// Smart context-window selection for mention/reply/ambient triggers.
//
// The old approach was a blunt slice: the last 10 messages before the trigger
// and the first 10 after. That pulls in parallel conversations when the group
// is busy and misses reply-anchored context when someone @-mentions Nick about
// a message from much earlier.
//
// This module does two things:
//   1. selectBurstWindow — walks outward from the trigger and cuts at the
//      first gap larger than burstGapSec. Capped by maxBefore / maxAfter.
//   2. extractQuotedAnchor — if the trigger replies to an older message that
//      fell outside the burst window, surface it as a separate anchor so the
//      reply isn't blind to what's being quoted.

export interface ContextMessage {
  id: string;
  timestamp: number; // unix seconds — WhatsApp's native unit
  body: string;
  // Any additional fields carried along are preserved but unused by this module.
  [key: string]: unknown;
}

export interface BurstOptions {
  burstGapSec: number; // e.g. 5 * 60 — a gap this large ends the burst
  maxBefore: number;
  maxAfter: number;
  // If set, always include at least this many of the most-recent pre-trigger
  // messages even when they fall outside the burst gap. Prevents Claude from
  // being starved of context when someone mentions Nick after a long silence.
  minBefore?: number;
}

export interface BurstWindow<M extends ContextMessage = ContextMessage> {
  before: M[];
  after: M[];
}

// Sort ascending by timestamp, with id as a tiebreaker so the order is stable
// across calls (WhatsApp can return messages with equal second-resolution ts).
function sortAsc<M extends ContextMessage>(msgs: M[]): M[] {
  return [...msgs].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function dedupeById<M extends ContextMessage>(msgs: M[]): M[] {
  const seen = new Set<string>();
  const out: M[] = [];
  for (const m of msgs) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

export function selectBurstWindow<M extends ContextMessage>(
  pool: M[],
  trigger: ContextMessage,
  opts: BurstOptions,
): BurstWindow<M> {
  // Defensive: if the trigger timestamp is not a finite number (rare WA
  // quirks with forwarded/system messages), every comparison returns false
  // and we produce empty before/after. Return early to make this explicit.
  if (!Number.isFinite(trigger.timestamp)) {
    return { before: [], after: [] };
  }

  const sorted = sortAsc(dedupeById(pool));
  const withoutTrigger = sorted.filter(m => m.id !== trigger.id);

  const beforePool = withoutTrigger.filter(m => m.timestamp <= trigger.timestamp);
  const afterPool = withoutTrigger.filter(m => m.timestamp > trigger.timestamp);

  // BEFORE: walk backwards from the most recent pre-trigger message.
  // Stop when a gap between adjacent selected messages exceeds burstGapSec,
  // or when we've collected maxBefore messages.
  const before: M[] = [];
  let prevTs = trigger.timestamp;
  for (let i = beforePool.length - 1; i >= 0; i--) {
    const m = beforePool[i];
    if (prevTs - m.timestamp > opts.burstGapSec) break;
    before.unshift(m);
    prevTs = m.timestamp;
    if (before.length >= opts.maxBefore) break;
  }

  // Floor: if the burst returned fewer than minBefore messages, pad with
  // the most-recent pre-trigger messages (ignoring the burst cutoff) until
  // we hit minBefore or run out. Never exceeds maxBefore.
  if (opts.minBefore && before.length < opts.minBefore) {
    const target = Math.min(opts.minBefore, opts.maxBefore, beforePool.length);
    const existing = new Set(before.map(m => m.id));
    for (let i = beforePool.length - 1; i >= 0 && before.length < target; i--) {
      const m = beforePool[i];
      if (existing.has(m.id)) continue;
      before.unshift(m);
      existing.add(m.id);
    }
    // Re-sort: floor entries were unshifted in reverse-chronological order
    // but the walk may have interleaved them with burst entries.
    before.sort((a, b) => a.timestamp - b.timestamp);
  }

  // AFTER: walk forward from the first post-trigger message.
  const after: M[] = [];
  prevTs = trigger.timestamp;
  for (const m of afterPool) {
    if (m.timestamp - prevTs > opts.burstGapSec) break;
    after.push(m);
    prevTs = m.timestamp;
    if (after.length >= opts.maxAfter) break;
  }

  return { before, after };
}

export interface AnchorContext {
  windowIds: Set<string>;
}

// Returns the quoted message IFF it exists and is not already part of the
// selected burst window. Callers render it as a separate "earlier context"
// section so the reply sees what's being quoted without duplicating it.
export function extractQuotedAnchor<M extends ContextMessage>(
  quoted: M | null | undefined,
  ctx: AnchorContext,
): M | null {
  if (!quoted) return null;
  if (ctx.windowIds.has(quoted.id)) return null;
  return quoted;
}
