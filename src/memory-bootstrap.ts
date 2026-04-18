import 'dotenv/config';
import {
  createClient,
  waitForReady,
  fetchAllChats,
  fetchMessages,
  formatMessageLine,
  getOwnerId,
} from './whatsapp';
import { callClaude } from './claude';
import { MEMORY_UPDATE_PROMPT, fillTemplate } from './prompts';
import {
  writeContactMemory,
  readContactMemory,
  isCusJid,
} from './memory';

// CLI flag parser — simple, no dep. Supports "--key=value" and "--key value".
function parseFlag(name: string, defaultValue: number): number {
  const args = process.argv.slice(2);
  const eq = args.find(a => a.startsWith(`--${name}=`));
  if (eq) {
    const val = Number(eq.split('=')[1]);
    return Number.isFinite(val) ? val : defaultValue;
  }
  const idx = args.findIndex(a => a === `--${name}`);
  if (idx !== -1 && args[idx + 1]) {
    const val = Number(args[idx + 1]);
    return Number.isFinite(val) ? val : defaultValue;
  }
  return defaultValue;
}

async function main(): Promise<void> {
  const topKChats = parseFlag('top-k-chats', 10);
  const minMessagesFromThem = parseFlag('min-messages-from-them', 3);
  const minMessagesFromNick = parseFlag('min-messages-from-nick', 3);

  console.log(
    `Bootstrap config: top-k-chats=${topKChats}, min-messages-from-them=${minMessagesFromThem}, min-messages-from-nick=${minMessagesFromNick}`,
  );

  const client = createClient();
  client.initialize();
  console.log('Waiting for WhatsApp to be ready...');
  await waitForReady(client);

  const ownerId = getOwnerId(client);
  console.log(`Bot online as ${ownerId}. Starting bootstrap.`);

  console.log('Fetching all chats...');
  const chats = await fetchAllChats(client);
  // We only bootstrap from group chats — per the design doc, v1 scope is
  // groups only. DM-derived memory is deferred.
  const groupChats = chats.filter((c: { isGroup?: boolean }) => c.isGroup);
  console.log(`Found ${groupChats.length} group chats.`);

  // Score each group by how many messages Nick sent in it (activity proxy).
  // We'll only bootstrap from the top K.
  const scored: Array<{ chat: any; score: number }> = [];
  for (const chat of groupChats) {
    try {
      const msgs = await fetchMessages(chat, 500);
      const nickMessageCount = msgs.filter((m: any) => m.fromMe).length;
      scored.push({ chat, score: nickMessageCount });
    } catch (err) {
      console.warn(`  skip scoring "${(chat as { name?: string }).name}": ${(err as Error).message.split('\n')[0]}`);
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const topChats = scored.slice(0, topKChats);
  console.log(`Bootstrapping from top ${topChats.length} most-active groups.`);

  let contactsProcessed = 0;
  let contactsWritten = 0;
  let contactsSkipped = 0;

  for (const { chat, score } of topChats) {
    console.log(`\n[group] "${chat.name}" (${score} of Nick's messages)`);
    let msgs: any[];
    try {
      msgs = await fetchMessages(chat, 500);
    } catch (err) {
      console.warn(`  skip group: ${(err as Error).message.split('\n')[0]}`);
      continue;
    }

    // Group messages by author JID. Drop Nick's own messages from the
    // per-author bucket (Nick isn't a "contact" — he's the owner).
    const byAuthor = new Map<string, any[]>();
    for (const m of msgs) {
      const author = m.author ?? m.from;
      if (!author || m.fromMe) continue;
      if (!byAuthor.has(author)) byAuthor.set(author, []);
      byAuthor.get(author)!.push(m);
    }

    // Count how many messages Nick sent in this specific chat — same for all
    // authors here, but the bootstrap prompt benefits from knowing Nick talks
    // in this group.
    const nickMsgsInChat = msgs.filter((m: any) => m.fromMe).length;
    if (nickMsgsInChat < minMessagesFromNick) {
      console.log(`  skip: Nick only sent ${nickMsgsInChat} messages here (<${minMessagesFromNick})`);
      continue;
    }

    for (const [authorJid, authorMsgs] of byAuthor) {
      contactsProcessed++;
      if (authorMsgs.length < minMessagesFromThem) {
        console.log(`  skip ${authorJid}: only ${authorMsgs.length} messages (<${minMessagesFromThem})`);
        contactsSkipped++;
        continue;
      }

      // Canonical key: resolve via the Contact object, which always yields
      // the @c.us form regardless of whether `msg.author` was @lid or @c.us.
      // This is more reliable than walking `chat.participants` because the
      // participants list sometimes doesn't expose the `lid` field.
      let contactName = 'Unknown';
      let cusJid: string | null = null;
      try {
        const contact = await authorMsgs[0].getContact();
        contactName = contact.pushname || contact.number || authorJid;
        const contactId = contact.id?._serialized;
        if (contactId && isCusJid(contactId)) {
          cusJid = contactId;
        }
      } catch (err) {
        console.log(`  skip ${authorJid}: getContact failed: ${(err as Error).message.split('\n')[0]}`);
        contactsSkipped++;
        continue;
      }

      if (!cusJid) {
        console.log(`  skip ${authorJid}: could not resolve to @c.us (contactName=${contactName})`);
        contactsSkipped++;
        continue;
      }

      // Skip if we already have a file — bootstrap is intentionally
      // non-destructive. Running it twice is safe.
      if (readContactMemory(cusJid)) {
        console.log(`  skip ${cusJid}: file already exists`);
        contactsSkipped++;
        continue;
      }

      // Messages from this contact (most recent 20)
      const theirRecent = authorMsgs.slice(-20);
      // Nick's messages interleaved by time — take the last ~10 Nick sent
      // in this chat as the "reply" context
      const nickRecent = msgs.filter((m: any) => m.fromMe).slice(-10);

      const theirLines = await Promise.all(
        theirRecent.map(async (m: any) => {
          try {
            const c = await m.getContact();
            return formatMessageLine(m, c.pushname || c.number || 'them');
          } catch {
            return formatMessageLine(m, 'them');
          }
        }),
      );
      const nickLines = nickRecent.map((m: any) => formatMessageLine(m, 'Nick'));

      const today = new Date().toISOString().slice(0, 10);
      // Reuse MEMORY_UPDATE_PROMPT with synthetic fields — BEFORE=their history,
      // MENTION=most-recent message from them, AFTER=Nick's recent replies,
      // NICK_REPLY=Nick's most recent reply in this chat.
      const prompt = fillTemplate(MEMORY_UPDATE_PROMPT, {
        CURRENT_MEMORY: '(no file yet)',
        CONTACT_NAME: contactName,
        CONTACT_JID: cusJid,
        BEFORE_MESSAGES: theirLines.slice(0, -1).join('\n') || '(no messages)',
        MENTION_MESSAGE: theirLines[theirLines.length - 1] ?? '(no recent message)',
        AFTER_MESSAGES: nickLines.slice(0, -1).join('\n') || '(no messages)',
        NICK_REPLY: nickLines[nickLines.length - 1] ?? '(no recent reply)',
        TODAY: today,
      });

      try {
        const updated = (await callClaude(prompt)).trim();
        if (updated) {
          writeContactMemory(cusJid, updated);
          console.log(`  wrote ${cusJid} "${contactName}" (${updated.length} chars)`);
          contactsWritten++;
        } else {
          console.warn(`  empty output for ${cusJid} — skipping`);
          contactsSkipped++;
        }
      } catch (err) {
        console.warn(`  claude failed for ${cusJid}: ${(err as Error).message.split('\n')[0]}`);
        contactsSkipped++;
      }
    }
  }

  console.log(
    `\nBootstrap complete. Processed: ${contactsProcessed}, written: ${contactsWritten}, skipped: ${contactsSkipped}`,
  );
  console.log('Review files in data/contacts/ before running npm start.');
  await client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
