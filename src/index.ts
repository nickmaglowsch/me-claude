import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  createClient,
  waitForReady,
  getOwnerName,
  getOwnerId,
  formatMessageLine,
} from './whatsapp';
import { callClaudeWithTools } from './claude';
import { RUNTIME_PROMPT, AMBIENT_PROMPT_PREFIX, fillTemplate } from './prompts';
import { resolveToCus } from './memory';
import { logEvent } from './events';
import { parseCommand, dispatchCommand, normalizeChatKey } from './commands';
import { ensureGroupFolder, persistMessage, localDate } from './groups';
import { selectBurstWindow, extractQuotedAnchor, type ContextMessage } from './context';
import {
  loadAmbientConfig,
  saveAmbientConfig,
  ensureDailyReset,
  buildTopicBank,
  loadMemoryTopics,
  shouldAmbientReply,
  recordAmbientReply,
  type AmbientDecision,
} from './ambient';

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

// Memory read/write is now handled by Claude itself via Read/Edit/Write tools
// in callClaudeWithTools. We no longer pre-load memory files or post-write them
// from here — Claude decides what to read and what to update on its own.
//
// TODO(memory-guard): Claude's Edit/Write tool calls bypass memory-guard.ts entirely.
// guardedWriteContactMemory is only invoked by memory-bootstrap.ts. A future task
// can add a post-claude hook that inspects git diff after callClaudeWithTools returns
// and validates any memory file changes against the corruption rules retroactively.

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
          const folder = ensureGroupFolder(chat.id._serialized, chat.name ?? '');
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
          dbg(`persisted to ${folder}/${localDate(tsMs)}`);
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

      // Gate 3: we must be mentioned OR they must be replying to one of our messages
      let trigger: 'mention' | 'reply' | 'ambient' | null = null;
      if (isMentioned(msg.mentionedIds, ownerIds)) {
        trigger = 'mention';
      } else if (msg.hasQuotedMsg) {
        try {
          const quoted = await msg.getQuotedMessage();
          if (quoted?.fromMe) trigger = 'reply';
        } catch (e) {
          dbg(`getQuotedMessage failed: ${(e as Error).message}`);
        }
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
          ambientDecision = shouldAmbientReply({
            cfg,
            chatName: chat.name,
            messageBody: msg.body || '',
            topicBank,
          });
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

        // Ambient triggered
        trigger = 'ambient';
        dbg(`ambient triggered: matchedTopic=${ambientDecision.matchedTopic} score=${ambientDecision.score}`);
        logEvent({
          kind: 'ambient.considered',
          chat: chat.name,
          chat_id: chat.id._serialized,
          matchedTopic: ambientDecision.matchedTopic,
          score: ambientDecision.score,
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
      });

      // If the mention is a reply to an older message that fell outside the
      // burst window, surface it as a separate QUOTED block. Skip silently
      // on any whatsapp-web.js error — the reply still works without it.
      let quotedAnchorRaw: any = null;
      if (msg.hasQuotedMsg) {
        try {
          const q = await msg.getQuotedMessage();
          if (q) {
            const windowIds = new Set<string>([
              ...before.map(m => m.id),
              ...after.map(m => m.id),
            ]);
            const anchor = extractQuotedAnchor(toCtxMsg(q), { windowIds });
            if (anchor) quotedAnchorRaw = (anchor as any)._raw;
          }
        } catch (e) {
          dbg(`quoted anchor fetch failed: ${(e as Error).message}`);
        }
      }

      // Helper: format a message line (requires resolving sender name)
      const formatLine = async (m: any): Promise<string> => {
        const contact = await m.getContact();
        const senderName = contact.pushname || contact.number || 'Unknown';
        return formatMessageLine(m, senderName);
      };

      // Format mention sender. Prefer the Contact object's @c.us id for the
      // memory key — it's the canonical form Claude will use when Read/Edit'ing
      // data/contacts/<jid>.md, regardless of whether msg.author was @lid.
      const mentionContact = await msg.getContact();
      const mentionSenderName = mentionContact.pushname || mentionContact.number || 'Someone';
      const rawSenderJid = msg.author ?? msg.from;
      const senderCus =
        mentionContact.id?._serialized && mentionContact.id._serialized.endsWith('@c.us')
          ? mentionContact.id._serialized
          : resolveToCus(rawSenderJid, chat);

      // Format all message lines using the back-referenced raw messages.
      const beforeLines = await Promise.all(
        before.map(m => formatLine((m as any)._raw))
      );
      const afterLines = await Promise.all(
        after.map(m => formatLine((m as any)._raw))
      );
      const mentionLine = formatMessageLine(msg, mentionSenderName);
      const quotedLine = quotedAnchorRaw ? await formatLine(quotedAnchorRaw) : null;

      // Look up the archive folder for this group so Claude can grep it if
      // the conversation references something older than the burst window.
      const groupFolder = ensureGroupFolder(chat.id._serialized, chat.name ?? '');

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
      const response = await callClaudeWithTools(fillTemplate(promptTemplate, vars));
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

      const sentMsg = await msg.reply(reply);
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
