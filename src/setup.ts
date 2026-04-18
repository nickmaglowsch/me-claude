import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  createClient,
  waitForReady,
  fetchAllChats,
  fetchMessages,
  formatRawMessage,
  getOwnerName,
  getOwnerId,
} from './whatsapp';
import { callClaude } from './claude';
import { META_PROMPT, fillTemplate } from './prompts';
import {
  filterMessages,
  stratifiedSampleByChat,
  shuffle,
  checkMinimumVolume,
  formatMessagesForPrompt,
  RawMessage,
} from './extract';

async function main(): Promise<void> {
  const client = createClient();
  client.initialize();
  console.log('Waiting for WhatsApp to be ready (scan QR code if prompted)...');
  await waitForReady(client);

  // Owner ID resolution
  const detectedId = getOwnerId(client);
  const ownerId = process.env.OWNER_ID ?? detectedId;
  console.log(`Auto-detected owner ID: ${detectedId}. Using: ${ownerId}.`);

  const ownerName = getOwnerName(client);
  console.log(`Bot online as ${ownerName} (${ownerId})`);

  console.log('Fetching all chats...');
  const chats = await fetchAllChats(client);
  console.log(`Found ${chats.length} chats.`);

  // Collect messages per chat (for stratified sampling).
  // whatsapp-web.js periodically breaks on specific chat types (newsletters,
  // broadcasts, status) when WA Web's internal JS changes. Swallow per-chat
  // errors so one bad chat doesn't abort the whole crawl.
  const perChatMessages: RawMessage[][] = [];
  let skipped = 0;
  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    if ((i + 1) % 25 === 0 || i === chats.length - 1) {
      console.log(`  [${i + 1}/${chats.length}] chats processed, ${skipped} skipped`);
    }
    try {
      const msgs = await fetchMessages(chat, 500);
      const raw = msgs.map(formatRawMessage);
      const filtered = filterMessages(raw);
      if (filtered.length > 0) {
        perChatMessages.push(filtered);
      }
    } catch (err) {
      skipped++;
      const name = (chat as { name?: string }).name ?? (chat as { id?: { _serialized?: string } }).id?._serialized ?? '(unknown)';
      console.warn(`  skip chat "${name}": ${(err as Error).message.split('\n')[0]}`);
    }
  }
  console.log(`Collected messages from ${perChatMessages.length} chats (${skipped} skipped).`);

  // Stratified sample: up to 50 per chat
  const sampled = stratifiedSampleByChat(perChatMessages, 50);
  console.log(`After stratified sampling: ${sampled.length} messages.`);

  // Volume check — abort if insufficient history
  checkMinimumVolume(sampled); // throws if < 100

  // Light shuffle to avoid recency bias
  const shuffled = shuffle(sampled);

  // Format for prompt
  const formatted = formatMessagesForPrompt(shuffled);

  // Fill and call
  const prompt = fillTemplate(META_PROMPT, {
    MESSAGES_GO_HERE: formatted,
  });

  console.log('Calling Claude to generate voice profile...');
  const voiceProfile = await callClaude(prompt);

  // Write output
  const dataDir = path.join(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const outputPath = path.join(dataDir, 'voice_profile.md');
  fs.writeFileSync(outputPath, voiceProfile, 'utf8');
  console.log('Voice profile written to data/voice_profile.md. Review it before going live.');

  await client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
