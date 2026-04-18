import 'dotenv/config';
import {
  createClient,
  waitForReady,
  fetchAllChats,
  fetchMessages,
  getOwnerId,
} from './whatsapp';
import { callClaude } from './claude';
import { BOOTSTRAP_PROMPT, fillTemplate } from './prompts';
import { writeContactMemoryGuarded, readContactMemory, isCusJid } from './memory';
import { logEvent } from './events';

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

// Per-group sample of one contact's messages. We stratify across groups when
// building the final prompt so a contact who talks in 3 groups gets a balanced
// cross-section, not just the most-active group's chatter.
interface GroupSample {
  groupName: string;
  theirMessages: Array<{ ts: number; body: string; hh: string }>;
  nickMessages: Array<{ ts: number; body: string; hh: string }>;
}

// Aggregate state: one entry per canonical @c.us JID, with samples from every
// group we've seen them in.
interface ContactAggregate {
  cusJid: string;
  name: string;
  groups: Map<string, GroupSample>; // key: chat name
  totalTheirMessages: number;
}

function formatHM(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  const topKChats = parseFlag('top-k-chats', 10);
  const minMessagesFromThem = parseFlag('min-messages-from-them', 3);
  const minMessagesFromNick = parseFlag('min-messages-from-nick', 3);
  const perContactPerGroupCap = parseFlag('per-contact-per-group', 40);
  const perContactTotalCap = parseFlag('per-contact-total', 150);

  console.log(
    `Bootstrap config: top-k-chats=${topKChats} min-theirs=${minMessagesFromThem} min-nicks=${minMessagesFromNick} per-group-cap=${perContactPerGroupCap} total-cap=${perContactTotalCap}`,
  );

  const client = createClient();
  client.initialize();
  console.log('Waiting for WhatsApp to be ready...');
  await waitForReady(client);

  const ownerId = getOwnerId(client);
  console.log(`Bot online as ${ownerId}. Starting bootstrap.`);

  console.log('Fetching all chats...');
  const chats = await fetchAllChats(client);
  const groupChats = chats.filter((c: { isGroup?: boolean }) => c.isGroup);
  console.log(`Found ${groupChats.length} group chats.`);

  // Score each group by how many messages Nick sent. Take top K most-active.
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
  console.log(`Walking top ${topChats.length} most-active groups to aggregate contacts...`);

  // Phase 1: aggregate messages per contact across ALL top-K groups.
  const aggregate = new Map<string, ContactAggregate>();

  for (const { chat, score } of topChats) {
    console.log(`\n[aggregate] "${chat.name}" (Nick's messages: ${score})`);
    if (score < minMessagesFromNick) {
      console.log(`  skip group: Nick only sent ${score} messages here (<${minMessagesFromNick})`);
      continue;
    }

    let msgs: any[];
    try {
      msgs = await fetchMessages(chat, 500);
    } catch (err) {
      console.warn(`  skip group: ${(err as Error).message.split('\n')[0]}`);
      continue;
    }

    const nickMsgs = msgs.filter((m: any) => m.fromMe);

    // Group messages by author (excluding Nick).
    const byAuthor = new Map<string, any[]>();
    for (const m of msgs) {
      const author = m.author ?? m.from;
      if (!author || m.fromMe) continue;
      if (!byAuthor.has(author)) byAuthor.set(author, []);
      byAuthor.get(author)!.push(m);
    }

    for (const [authorJid, authorMsgs] of byAuthor) {
      // Canonical @c.us via Contact object. More reliable than walking
      // chat.participants because pushname + number come back either way.
      let name = 'Unknown';
      let cusJid: string | null = null;
      try {
        const contact = await authorMsgs[0].getContact();
        name = contact.pushname || contact.number || authorJid;
        const id = contact.id?._serialized;
        if (id && isCusJid(id)) cusJid = id;
      } catch {
        /* skip */
      }
      if (!cusJid) continue;

      // Take the last N of their messages in this group, chronologically.
      const sampleOfTheirs = authorMsgs
        .slice(-perContactPerGroupCap)
        .map((m: any) => ({ ts: m.timestamp, body: m.body as string, hh: formatHM(m.timestamp) }));
      // Take the last N/3 of Nick's messages as tone signal.
      const sampleOfNicks = nickMsgs
        .slice(-Math.max(10, Math.floor(perContactPerGroupCap / 3)))
        .map((m: any) => ({ ts: m.timestamp, body: m.body as string, hh: formatHM(m.timestamp) }));

      if (!aggregate.has(cusJid)) {
        aggregate.set(cusJid, {
          cusJid,
          name,
          groups: new Map(),
          totalTheirMessages: 0,
        });
      }
      const entry = aggregate.get(cusJid)!;
      // Prefer pushname over number if we pick up a better name later.
      if (name && name !== 'Unknown' && entry.name === 'Unknown') entry.name = name;
      entry.groups.set(chat.name as string, {
        groupName: chat.name as string,
        theirMessages: sampleOfTheirs,
        nickMessages: sampleOfNicks,
      });
      entry.totalTheirMessages += authorMsgs.length;
    }
  }

  console.log(`\nAggregated ${aggregate.size} unique contacts across all groups.`);

  // Phase 2: build + write memory file per contact.
  let written = 0;
  let skippedTooFew = 0;
  let skippedFileExists = 0;
  let skippedClaudeEmpty = 0;
  let skippedClaudeErr = 0;

  // Order contacts by total-message-count desc so if we hit API limits the
  // most valuable files land first.
  const ordered = [...aggregate.values()].sort((a, b) => b.totalTheirMessages - a.totalTheirMessages);

  for (const entry of ordered) {
    if (entry.totalTheirMessages < minMessagesFromThem) {
      skippedTooFew++;
      logEvent({ kind: 'bootstrap.contact_skipped', sender_jid: entry.cusJid, reason: 'too_few_messages' });
      continue;
    }
    if (readContactMemory(entry.cusJid)) {
      console.log(`  skip ${entry.cusJid} "${entry.name}": file already exists`);
      skippedFileExists++;
      logEvent({ kind: 'bootstrap.contact_skipped', sender_jid: entry.cusJid, reason: 'file_exists' });
      continue;
    }

    // Stratified sample across their groups — interleave so the prompt sees
    // all their groups represented, not the first one taking the whole budget.
    const theirPool: Array<{ ts: number; body: string; hh: string; group: string }> = [];
    const nickPool: Array<{ ts: number; body: string; hh: string; group: string }> = [];
    for (const [gName, sample] of entry.groups) {
      for (const m of sample.theirMessages) theirPool.push({ ...m, group: gName });
      for (const m of sample.nickMessages) nickPool.push({ ...m, group: gName });
    }
    theirPool.sort((a, b) => a.ts - b.ts);
    nickPool.sort((a, b) => a.ts - b.ts);

    // Cap total messages sent to claude
    const theirsCapped = theirPool.slice(-perContactTotalCap);
    const nicksCapped = nickPool.slice(-Math.floor(perContactTotalCap / 3));

    const theirLines = theirsCapped
      .map(m => `[${m.hh} group=${m.group}] ${m.body}`)
      .join('\n') || '(no messages)';
    const nickLines = nicksCapped
      .map(m => `[${m.hh} group=${m.group}] ${m.body}`)
      .join('\n') || '(no messages)';
    const groupsList = [...entry.groups.keys()].join(', ');
    const today = new Date().toISOString().slice(0, 10);

    const prompt = fillTemplate(BOOTSTRAP_PROMPT, {
      CONTACT_NAME: entry.name,
      CONTACT_JID: entry.cusJid,
      GROUPS_LIST: groupsList,
      TODAY: today,
      THEIR_MESSAGES: theirLines,
      NICK_MESSAGES: nickLines,
    });

    const writeStart = Date.now();
    try {
      const output = (await callClaude(prompt)).trim();
      if (!output) {
        console.warn(`  empty output for ${entry.cusJid} "${entry.name}" — skipping`);
        skippedClaudeEmpty++;
        logEvent({ kind: 'bootstrap.contact_skipped', sender_jid: entry.cusJid, reason: 'claude_empty' });
        continue;
      }
      const guardResult = await writeContactMemoryGuarded(entry.cusJid, output, { reason: 'bootstrap' });
      if (guardResult.status === 'rejected') {
        console.warn(`  guard rejected ${entry.cusJid} "${entry.name}": ${guardResult.reason}`);
        skippedClaudeEmpty++; // reuse the skip counter for guard rejections
        logEvent({ kind: 'bootstrap.contact_skipped', sender_jid: entry.cusJid, reason: `guard_rejected: ${guardResult.reason}` });
        continue;
      }
      console.log(
        `  wrote ${entry.cusJid} "${entry.name}" — ${entry.groups.size} group(s), ${entry.totalTheirMessages} of their msgs, ${output.length} chars [guard: ${guardResult.status}]`,
      );
      logEvent({ kind: 'bootstrap.contact_written', sender_jid: entry.cusJid, duration_ms: Date.now() - writeStart });
      written++;
    } catch (err) {
      console.warn(`  claude failed for ${entry.cusJid} "${entry.name}": ${(err as Error).message.split('\n')[0]}`);
      skippedClaudeErr++;
      logEvent({ kind: 'bootstrap.contact_skipped', sender_jid: entry.cusJid, reason: `claude_error: ${(err as Error).message.split('\n')[0]}` });
    }
  }

  console.log(
    `\nBootstrap complete. Written: ${written}. Skipped: ${skippedTooFew} too few msgs + ${skippedFileExists} file existed + ${skippedClaudeEmpty} claude returned empty + ${skippedClaudeErr} claude errored.`,
  );
  console.log('Review files in data/contacts/ before running npm start.');
  await client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
