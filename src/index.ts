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
import { callClaude } from './claude';
import { RUNTIME_PROMPT, fillTemplate } from './prompts';

// Rate limiter: group JID → timestamp of last reply (ms)
const lastReplyAt = new Map<string, number>();
const RATE_LIMIT_MS = 10_000;  // 1 reply per group per 10 seconds
const AFTER_WAIT_MS = 8_000;   // wait before replying (to collect after-messages)

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

      // Gate 1: must be in a group chat
      let chat;
      try {
        chat = await msg.getChat();
      } catch (e) {
        dbg(`skip: getChat failed: ${(e as Error).message}`);
        return;
      }
      if (!chat.isGroup) { dbg(`skip: not a group (${chat.name ?? chat.id?._serialized})`); return; }

      // Gate 2: must not be our own message
      if (msg.fromMe) { dbg(`skip: fromMe in [${chat.name}]`); return; }

      // Log every group message received with mention info so we can see the raw shape
      dbg(`msg in [${chat.name}]: body="${(msg.body || '').slice(0, 60)}" mentionedIds=${JSON.stringify(msg.mentionedIds)} hasQuoted=${msg.hasQuotedMsg}`);

      // Gate 3: we must be mentioned OR they must be replying to one of our messages
      let trigger: 'mention' | 'reply' | null = null;
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
      if (!trigger) {
        dbg(`skip: not mentioned, not a reply to us (owners=${JSON.stringify(ownerIds)})`);
        return;
      }

      console.log(`[${trigger}] [${chat.name}] ${msg.body?.slice(0, 80) ?? ''}`);

      // Gate 4: rate limit (10s per group)
      const groupJid = chat.id._serialized;
      const nowMs = Date.now();
      if (isRateLimited(lastReplyAt, groupJid, nowMs, RATE_LIMIT_MS)) {
        console.log(`[${trigger}] skipped: rate-limited in [${chat.name}]`);
        return;
      }
      recordReply(lastReplyAt, groupJid, nowMs);

      // Fetch BEFORE context: last 11 messages, exclude the mention itself
      const beforeFetch = await chat.fetchMessages({ limit: 11 });
      const beforeMessages = beforeFetch
        .filter((m: any) => m.id._serialized !== msg.id._serialized)
        .slice(-10); // up to 10, most recent

      // Wait 8 seconds for possible "after" messages
      await sleep(AFTER_WAIT_MS);

      // Fetch AFTER context: messages that arrived after the mention's timestamp
      const afterFetch = await chat.fetchMessages({ limit: 20 });
      const afterMessages = afterFetch
        .filter((m: any) => m.timestamp > msg.timestamp && m.id._serialized !== msg.id._serialized)
        .slice(0, 10); // up to 10

      // Helper: format a message line (requires resolving sender name)
      const formatLine = async (m: any): Promise<string> => {
        const contact = await m.getContact();
        const senderName = contact.pushname || contact.number || 'Unknown';
        return formatMessageLine(m, senderName);
      };

      // Format mention sender
      const mentionContact = await msg.getContact();
      const mentionSenderName = mentionContact.pushname || mentionContact.number || 'Someone';

      // Format all message lines
      const beforeLines = await Promise.all(beforeMessages.map(formatLine));
      const afterLines = await Promise.all(afterMessages.map(formatLine));
      const mentionLine = formatMessageLine(msg, mentionSenderName);

      // Build prompt vars
      const vars = {
        VOICE_PROFILE_GOES_HERE: voiceProfile,
        BEFORE_MESSAGES: beforeLines.length > 0 ? beforeLines.join('\n') : '(no messages before)',
        MENTION_MESSAGE: mentionLine,
        AFTER_MESSAGES: afterLines.length > 0 ? afterLines.join('\n') : '(no messages after yet)',
      };

      const response = await callClaude(fillTemplate(RUNTIME_PROMPT, vars));
      const reply = response.trim();

      // Silence is allowed — if Claude returns empty, skip
      if (!reply) return;

      await msg.reply(reply);

      // Log the handled mention
      console.log(`[${chat.name}] ${mentionSenderName}: ${msg.body} -> ${reply}`);
    } catch (err) {
      console.error('Error handling message:', err);
    }
  });

  console.log('Listening for mentions...');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
