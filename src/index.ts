import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  createClient,
  waitForReady,
  getOwnerName,
  getOwnerId,
  formatMessageLine,
  resolveSenderName,
  resolveSenderContact,
} from './whatsapp';
import { callClaudeWithTools } from './claude';
import { RUNTIME_PROMPT, AMBIENT_PROMPT_PREFIX, fillTemplate } from './prompts';
import { resolveToCus } from './memory';
import { logEvent } from './events';
import { parseCommand, dispatchCommand, normalizeChatKey } from './commands';
import { ensureGroupFolder, persistMessage, localDate } from './groups';
import { createSandbox, destroySandbox, sanitizePushname } from './sandbox';
import { selectBurstWindow, extractQuotedAnchor, type ContextMessage } from './context';
import {
  loadAmbientConfig,
  saveAmbientConfig,
  ensureDailyReset,
  buildTopicBank,
  loadMemoryTopics,
  shouldAmbientReply,
  recordAmbientReply,
  refineAmbientDecision,
  type AmbientDecision,
} from './ambient';
import { scoreFuzzy } from './fuzzy';
import { maybeRefreshFeedbackTopics } from './feedback-topics';

// Rate limiter: group JID → timestamp of last reply (ms)
const lastReplyAt = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;  // 1 reply per group per 10 seconds
const AFTER_WAIT_MS = 8_000;   // wait before replying (to collect after-messages)

// Context-window tuning. A "burst" is a run of messages with no gap larger
// than BURST_GAP_SEC — we include everything in the current burst up to the
// caps below. See src/context.ts.
const BURST_GAP_SEC = 5 * 60;   // 5 minutes — typical pause between threads
const MAX_BEFORE = 15;          // ceiling even if burst is longer
const MAX_AFTER = 10;
const MIN_BEFORE = 3;           // floor — even in a quiet chat, give Claude
                                // the 3 most recent pre-trigger messages so
                                // it isn't replying blind after a long silence
const FETCH_POOL_LIMIT = 40;    // how many raw messages to fetch per side

// Silence map: chat-name → muted-until-ms; "*" key for global mute.
// Managed by the !silence / !resume commands.
const silences = new Map<string, number>();

// Recursion guard: track message IDs of bot replies so they don't re-trigger
// the handler. Bounded to ~100 entries to prevent unbounded growth.
const recentOutboundIds = new Set<string>();
const MAX_OUTBOUND_IDS = 100;

// Exported pure helpers for testability

// Normalize a JID for comparison. The prefix (digits before "@") is preserved
// verbatim so @c.us phone IDs and @lid opaque IDs both work — just not against
// each other. Suffix after "@" is dropped so "5551@c.us" and "5551" both match.
function jidPrefix(id: string): string {
  return id.split('@')[0];
}

export function isMentioned(mentionedIds: unknown, ownerIds: string[]): boolean {
  // mentionedIds may be: string[], object[] with _serialized, or undefined
  if (!Array.isArray(mentionedIds)) return false;
  const ownerPrefixes = new Set(ownerIds.map(jidPrefix));
  return mentionedIds.some(raw => {
    const id = typeof raw === 'string' ? raw : (raw as { _serialized?: string })?._serialized ?? '';
    return ownerPrefixes.has(jidPrefix(id));
  });
}

export function isRateLimited(
  lastReplyAt: Map<string, number>,
  groupJid: string,
  nowMs: number,
  limitMs: number
): boolean {
  const last = lastReplyAt.get(groupJid);
  if (last === undefined) return false;
  return (nowMs - last) < limitMs;
}

export function recordReply(
  lastReplyAt: Map<string, number>,
  groupJid: string,
  nowMs: number
): void {
  lastReplyAt.set(groupJid, nowMs);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// mention/reply triggers use `msg.reply(...)` so the outbound message quotes
// the triggering message — that's the expected UX when someone @'s Nick or
// replies to him. Ambient triggers weren't invited into the thread, so we
// send a plain group message instead of quoting.
export type DispatchMode = 'reply' | 'send';

export function pickDispatchMode(trigger: 'mention' | 'reply' | 'ambient'): DispatchMode {
  return trigger === 'ambient' ? 'send' : 'reply';
}

// Memory read/write is now handled by Claude itself via Read/Edit/Write tools
// in callClaudeWithTools. We no longer pre-load memory files or post-write them
// from here — Claude decides what to read and what to update on its own.
//
// intentionally deferred — see security-refactor notes (task-01)
// Claude's Edit/Write tool calls bypass memory-guard.ts entirely.
// guardedWriteContactMemory is only invoked by memory-bootstrap.ts.
// V-002 deferred: the sandbox cwd (task-01) limits blast radius.

async function main(): Promise<void> {
  const client = createClient();
  client.initialize();
  console.log('Waiting for WhatsApp to be ready (scan QR code if prompted)...');
  await waitForReady(client);

  // Owner ID resolution. WhatsApp assigns each user two unrelated JIDs:
  //   - @c.us: phone-number-based (legacy, appears in DMs and client.info.wid)
  //   - @lid:  opaque linked-identifier (post-2024 WA uses this in group mentions)
  // We build a list of all IDs that count as "us" and match mentions against all of them.
  const detectedId = getOwnerId(client);
  const ownerCusId = process.env.OWNER_ID ?? detectedId;
  const rawInfo = (client as unknown as { info?: Record<string, unknown> }).info ?? {};
  console.log('Full client.info:', JSON.stringify(rawInfo, null, 2));
  const info = rawInfo as {
    wid?: { _serialized?: string };
    lid?: { _serialized?: string } | string;
    me?: { _serialized?: string };
  };
  const detectedLid =
    (typeof info.lid === 'object' ? info.lid?._serialized : info.lid) ??
    undefined;
  const ownerLidId = process.env.OWNER_LID ?? detectedLid;

  const ownerIds = [ownerCusId, ownerLidId].filter((x): x is string => !!x);
  console.log(`Owner IDs being matched against: ${JSON.stringify(ownerIds)}`);

  const ownerName = getOwnerName(client);
  console.log(`Bot online as ${ownerName} (${ownerCusId})`);

  // Load voice profile
  const profilePath = path.join(process.cwd(), 'data', 'voice_profile.md');
  if (!fs.existsSync(profilePath)) {
    console.error(`data/voice_profile.md not found. Run 'npm run setup' first.`);
    process.exit(1);
  }
  const voiceProfile = fs.readFileSync(profilePath, 'utf8');
  console.log('Voice profile loaded.');

  // Refresh feedback topics on startup (non-blocking, errors are swallowed).
  try {
    const startupCfg = loadAmbientConfig();
    const startupBank = buildTopicBank(startupCfg, loadMemoryTopics(), []);
    const fbResult = maybeRefreshFeedbackTopics(startupBank);
    if (fbResult.refreshed) {
      console.log(`[feedback] refreshed: ${fbResult.count} topics extracted`);
    }
  } catch (e) {
    console.warn('[feedback] maybeRefreshFeedbackTopics error on startup:', (e as Error).message);
  }

  const DEBUG = process.env.BOT_DEBUG === '1';
  const dbg = (...args: unknown[]): void => { if (DEBUG) console.log('[debug]', ...args); };

  // Register message handler
  client.on('message_create', async (msg: any) => {
    try {
      // Top-of-handler log so we can confirm the event is firing at all
      dbg(`event fromMe=${msg.fromMe} hasQuoted=${msg.hasQuotedMsg} body="${(msg.body || '').slice(0, 40)}"`);

      // Recursion guard: skip any message we sent ourselves (bot replies to
      // commands would otherwise re-trigger the handler in an infinite loop).
      const msgId = msg.id?._serialized;
      if (msgId && recentOutboundIds.has(msgId)) {
        dbg(`skip: outbound message already processed (id=${msgId})`);
        return;
      }

      // Gate 1: must be in a group chat
      let chat;
      try {
        chat = await msg.getChat();
      } catch (e) {
        dbg(`skip: getChat failed: ${(e as Error).message}`);
        logEvent({ kind: 'skip.get_chat_failed', reason: (e as Error).message });
        return;
      }

      // Self-chat command gate: fromMe + self-chat + starts with "!"
      // This MUST fire before the group gate so commands work in the self-chat DM.
      if (msg.fromMe && chat?.id?._serialized === ownerCusId) {
        const body = (msg.body || '').trim();
        if (body.startsWith('!')) {
          const parsed = parseCommand(body);
          if (parsed) {
            await dispatchCommand(parsed, {
              ownerCusId,
              reply: async (text: string) => {
                const sentMsg = await chat.sendMessage(text);
                // Track outbound reply IDs to prevent recursion
                const sentId = sentMsg?.id?._serialized;
                if (sentId) {
                  recentOutboundIds.add(sentId);
                  // Bounded LRU-ish eviction: drop oldest entries over cap
                  if (recentOutboundIds.size > MAX_OUTBOUND_IDS) {
                    const first = recentOutboundIds.values().next().value;
                    if (first !== undefined) recentOutboundIds.delete(first);
                  }
                }
              },
              silences,
            });
            return;
          }
        }
      }

      if (!chat.isGroup) {
        dbg(`skip: not a group (${chat.name ?? chat.id?._serialized})`);
        logEvent({ kind: 'skip.not_in_group', chat: chat.name ?? chat.id?._serialized });
        return;
      }

      // Archive folder for this group. Computed once per handler invocation
      // and reused by both the persist block and the prompt vars below.
      // ensureGroupFolder is a no-op disk read after the group is registered.
      const groupFolder = ensureGroupFolder(chat.id._serialized, chat.name ?? '');

      // Archive every group message for summary/search. Errors are swallowed
      // inside persistMessage; no gating here.
      // Skip system messages that have no conversational content.
      const SYSTEM_TYPES = new Set([
        'e2e_notification',
        'notification',
        'notification_template',
        'gp2',
        'group_notification',
        'revoked',
        'call_log',
      ]);
      if (!SYSTEM_TYPES.has(msg.type)) {
        try {
          const contact = msg.fromMe
            ? undefined
            : await msg.getContact().catch(() => undefined);
          const fromJid = (msg.fromMe
            ? ownerCusId
            : (contact?.id?._serialized ?? msg.author ?? msg.from ?? '')) as string;
          const fromName = contact?.pushname || contact?.number || (msg.fromMe ? 'Nick' : 'Unknown');
          const tsMs = (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
          const body = msg.type === 'chat' ? (msg.body ?? '') : `[${msg.type}]`;

          persistMessage({
            chatJid: chat.id._serialized,
            chatName: chat.name ?? '',
            msg: {
              ts: new Date(tsMs).toISOString(),
              local_date: localDate(tsMs),
              from_jid: fromJid,
              from_name: fromName,
              body,
              from_me: !!msg.fromMe,
              type: msg.type ?? 'unknown',
              id: msg.id?._serialized ?? '',
              has_quoted: !!msg.hasQuotedMsg,
              quoted_id: null,
            },
          });
          logEvent({ kind: 'group.persisted', chat_id: chat.id._serialized, chat: chat.name, msg_type: msg.type });
          dbg(`persisted to ${groupFolder}/${localDate(tsMs)}`);
        } catch (e) {
          dbg(`persist error: ${(e as Error).message}`);
        }
      }

      // Gate 2: must not be our own message
      if (msg.fromMe) {
        dbg(`skip: fromMe in [${chat.name}]`);
        logEvent({ kind: 'skip.from_me', chat: chat.name, chat_id: chat.id?._serialized });
        return;
      }

      // Log every group message received with mention info so we can see the raw shape
      dbg(`msg in [${chat.name}]: body="${(msg.body || '').slice(0, 60)}" mentionedIds=${JSON.stringify(msg.mentionedIds)} hasQuoted=${msg.hasQuotedMsg}`);

      // Resolve the quoted message ONCE — both trigger detection and the
      // anchor-block builder below need it, and every call is a round-trip
      // through whatsapp-web.js/puppeteer.
      let quotedMsg: any = null;
      if (msg.hasQuotedMsg) {
        try {
          quotedMsg = await msg.getQuotedMessage();
        } catch (e) {
          dbg(`getQuotedMessage failed: ${(e as Error).message}`);
        }
      }

      // Gate 3: we must be mentioned OR they must be replying to one of our messages
      let trigger: 'mention' | 'reply' | 'ambient' | null = null;
      if (isMentioned(msg.mentionedIds, ownerIds)) {
        trigger = 'mention';
      } else if (quotedMsg?.fromMe) {
        trigger = 'reply';
      }
      // Silence check: global mute ("*") or per-chat mute.
      // Runs BEFORE the ambient gate so silenced chats never reach topic-bank
      // fuzzy matching, regardless of whether there is a mention/reply trigger.
      const groupJid = chat.id._serialized;
      if (silences.has('*') && silences.get('*')! > Date.now()) {
        dbg(`skip: globally silenced`);
        logEvent({ kind: 'skip.silenced', reason: 'global', chat: chat.name, chat_id: groupJid });
        return;
      }
      if (silences.has(normalizeChatKey(chat.name)) && silences.get(normalizeChatKey(chat.name))! > Date.now()) {
        dbg(`skip: silenced chat [${chat.name}]`);
        logEvent({ kind: 'skip.silenced', reason: 'per-chat', chat: chat.name, chat_id: groupJid });
        return;
      }

      if (!trigger) {
        // No mention, no reply-to-Nick. Try ambient.
        let ambientDecision: AmbientDecision | null = null;
        try {
          const cfg = ensureDailyReset(loadAmbientConfig());
          const topicBank = buildTopicBank(cfg, loadMemoryTopics());
          const body = msg.body || '';
          ambientDecision = shouldAmbientReply({
            cfg,
            chatName: chat.name,
            messageBody: body,
            topicBank,
          });

          // If the sync gate failed with a fuzzy miss, ask Haiku to refine.
          // refineAmbientDecision returns one of: haiku classifier (pass),
          // haiku:none, or haiku:error — the reason field is the source of
          // truth for downstream logging.
          if (!ambientDecision.pass && ambientDecision.reason === 'no fuzzy match') {
            const topScore = scoreFuzzy(body, topicBank)?.score ?? 0;
            ambientDecision = await refineAmbientDecision({
              originalDecision: ambientDecision,
              topScore,
              messageBody: body,
              topicBank,
              cfg,
            }).catch((e: Error) => {
              dbg(`refineAmbientDecision threw: ${e.message}`);
              return { pass: false, reason: 'haiku:error' } as AmbientDecision;
            });
          }
        } catch (e) {
          dbg(`ambient gate threw: ${(e as Error).message}`);
        }

        if (!ambientDecision || !ambientDecision.pass) {
          dbg(`ambient skip: ${ambientDecision?.reason ?? 'gate error'}`);
          logEvent({
            kind: 'ambient.skipped',
            chat: chat.name,
            chat_id: chat.id._serialized,
            reason: ambientDecision?.reason ?? 'gate error',
          });
          return;
        }

        // Ambient triggered (bigram gate pass OR haiku classifier pass)
        trigger = 'ambient';
        dbg(`ambient triggered: matchedTopic=${ambientDecision.matchedTopic} score=${ambientDecision.score} reason=${ambientDecision.reason}`);
        logEvent({
          kind: 'ambient.considered',
          chat: chat.name,
          chat_id: chat.id._serialized,
          matchedTopic: ambientDecision.matchedTopic,
          score: ambientDecision.score,
          source: ambientDecision.reason === 'haiku classifier' ? 'haiku' : 'fuzzy',
        });
      }

      console.log(`[${trigger}] [${chat.name}] ${msg.body?.slice(0, 80) ?? ''}`);

      // Gate 4: rate limit (10s per group)
      const nowMs = Date.now();
      if (isRateLimited(lastReplyAt, groupJid, nowMs, RATE_LIMIT_MS)) {
        console.log(`[${trigger}] skipped: rate-limited in [${chat.name}]`);
        logEvent({ kind: 'skip.rate_limited', chat: chat.name, chat_id: groupJid, trigger });
        return;
      }
      recordReply(lastReplyAt, groupJid, nowMs);

      // Fetch a generous pool for BEFORE context; we'll trim it to a burst
      // window in memory so quiet chats get what they have and active bursts
      // get fewer messages from unrelated parallel threads.
      const beforeFetch = await chat.fetchMessages({ limit: FETCH_POOL_LIMIT });

      // Wait 8 seconds for possible "after" messages
      await sleep(AFTER_WAIT_MS);

      // Re-fetch after the wait to pick up AFTER-messages. We merge with the
      // BEFORE pool rather than filtering by timestamp so a single sorted pass
      // can do both the before and after burst trim.
      const afterFetch = await chat.fetchMessages({ limit: FETCH_POOL_LIMIT });
      const rawPool: any[] = [...beforeFetch, ...afterFetch];

      // Shape raw whatsapp-web.js messages into the ContextMessage interface.
      // We keep a back-reference (`_raw`) so the downstream formatter can call
      // getContact() / access hasQuotedMsg on the real object.
      const toCtxMsg = (m: any): ContextMessage & { _raw: any } => ({
        id: m.id._serialized,
        timestamp: m.timestamp,
        body: m.body ?? '',
        _raw: m,
      });
      const triggerCtx = toCtxMsg(msg);
      const poolCtx = rawPool.map(toCtxMsg);

      const { before, after } = selectBurstWindow(poolCtx, triggerCtx, {
        burstGapSec: BURST_GAP_SEC,
        maxBefore: MAX_BEFORE,
        maxAfter: MAX_AFTER,
        minBefore: MIN_BEFORE,
      });

      // If the mention is a reply to an older message that fell outside the
      // burst window, surface it as a separate QUOTED block. Reuses the
      // quotedMsg resolved above so we don't round-trip to puppeteer twice.
      //
      // Self-quote guard: if WA returns the trigger itself as its own quoted
      // message (edge case we've seen with forwarded/edited messages), skip —
      // duplicating MENTION into QUOTED would be worse than dropping it.
      let quotedAnchorRaw: any = null;
      if (quotedMsg && quotedMsg.id?._serialized !== msg.id?._serialized) {
        const windowIds = new Set<string>([
          ...before.map(m => m.id),
          ...after.map(m => m.id),
        ]);
        const anchor = extractQuotedAnchor(toCtxMsg(quotedMsg), { windowIds });
        if (anchor) quotedAnchorRaw = (anchor as any)._raw;
      }

      // Helper: format a message line. Sender resolution is fault-tolerant
      // so one @lid contact that trips whatsapp-web.js's getAlternateUserWid
      // bug doesn't reject the whole Promise.all window below. sanitizePushname
      // strips newlines/backticks so a hostile display name can't inject into
      // the BEFORE/AFTER blocks of the Claude prompt.
      const formatLine = async (m: any): Promise<string> => {
        const senderName = sanitizePushname(await resolveSenderName(m));
        return formatMessageLine(m, senderName);
      };

      // Format mention sender. Prefer the Contact object's @c.us id for the
      // memory key — it's the canonical form Claude will use when Read/Edit'ing
      // data/contacts/<jid>.md, regardless of whether msg.author was @lid.
      const mentionResolved = await resolveSenderContact(msg);
      const mentionSenderName = sanitizePushname(mentionResolved.name || 'Someone');
      const rawSenderJid = msg.author ?? msg.from;
      const senderCus = mentionResolved.cusJid ?? resolveToCus(rawSenderJid, chat);

      // Format all message lines using the back-referenced raw messages.
      const beforeLines = await Promise.all(
        before.map(m => formatLine((m as any)._raw))
      );
      const afterLines = await Promise.all(
        after.map(m => formatLine((m as any)._raw))
      );
      const mentionLine = formatMessageLine(msg, mentionSenderName);
      const quotedLine = quotedAnchorRaw ? await formatLine(quotedAnchorRaw) : null;

      logEvent({
        kind: 'context.window',
        chat: chat.name,
        chat_id: groupJid,
        before_count: before.length,
        after_count: after.length,
        has_quoted_anchor: !!quotedLine,
        burst_gap_sec: BURST_GAP_SEC,
      });

      // Build prompt vars. Memory file read/write is now Claude's job via
      // Read/Edit/Write tools — we only hand it the sender's canonical JID
      // so it knows which file to consult and update.
      const today = new Date().toISOString().slice(0, 10);
      const vars = {
        VOICE_PROFILE_GOES_HERE: voiceProfile,
        SENDER_NAME: mentionSenderName,
        SENDER_JID: senderCus ?? rawSenderJid ?? 'unknown',
        TODAY: today,
        QUOTED_BLOCK: quotedLine
          ? `QUOTED (older message being replied to):\n${quotedLine}\n\n`
          : '',
        BEFORE_MESSAGES: beforeLines.length > 0 ? beforeLines.join('\n') : '(no messages before)',
        MENTION_MESSAGE: mentionLine,
        AFTER_MESSAGES: afterLines.length > 0 ? afterLines.join('\n') : '(no messages after yet)',
        GROUP_FOLDER: groupFolder,
      };
      dbg(`handing off to claude w/ tools; sender=${vars.SENDER_JID}`);

      const promptTemplate =
        trigger === 'ambient' ? AMBIENT_PROMPT_PREFIX + RUNTIME_PROMPT : RUNTIME_PROMPT;
      const callStart = Date.now();
      const sandboxDir = await createSandbox(vars.SENDER_JID, vars.GROUP_FOLDER);
      const addDirs = [path.join(process.cwd(), 'data', 'contacts'), path.join(process.cwd(), 'data', 'groups')];
      let response = '';
      try {
        response = await callClaudeWithTools(fillTemplate(promptTemplate, vars), sandboxDir, addDirs);
      } finally {
        await destroySandbox(sandboxDir).catch((e: Error) =>
          console.warn('[sandbox] cleanup failed:', e.message)
        );
      }
      const callDurationMs = Date.now() - callStart;
      const reply = response.trim();

      // Silence is allowed — if Claude returns empty, skip
      if (!reply) {
        if (trigger === 'ambient') {
          logEvent({ kind: 'ambient.declined', chat: chat.name, chat_id: groupJid });
          return;
        }
        logEvent({
          kind: 'reply.silent',
          chat: chat.name,
          chat_id: groupJid,
          sender_name: mentionSenderName,
          sender_jid: vars.SENDER_JID,
          trigger,
          duration_ms: callDurationMs,
        });
        return;
      }

      const dispatchMode = pickDispatchMode(trigger);
      const sentMsg =
        dispatchMode === 'reply'
          ? await msg.reply(reply)
          : await chat.sendMessage(reply);
      // Track outbound ID for recursion guard
      const sentId = sentMsg?.id?._serialized;
      if (sentId) {
        recentOutboundIds.add(sentId);
        if (recentOutboundIds.size > MAX_OUTBOUND_IDS) {
          const first = recentOutboundIds.values().next().value;
          if (first !== undefined) recentOutboundIds.delete(first);
        }
      }

      // If ambient triggered, record the reply in the daily counter
      if (trigger === 'ambient') {
        const cfgAfter = recordAmbientReply(ensureDailyReset(loadAmbientConfig()));
        saveAmbientConfig(cfgAfter);
        logEvent({ kind: 'ambient.replied', chat: chat.name, trigger: 'ambient' });
      }

      // Log the handled mention
      console.log(`[${chat.name}] ${mentionSenderName}: ${msg.body} -> ${reply}`);
      logEvent({
        kind: 'reply.sent',
        chat: chat.name,
        chat_id: groupJid,
        sender_name: mentionSenderName,
        sender_jid: vars.SENDER_JID,
        trigger,
        duration_ms: callDurationMs,
      });
    } catch (err) {
      console.error('Error handling message:', err);
      logEvent({ kind: 'error', reason: (err as Error).message });
    }
  });

  console.log('Listening for mentions...');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
