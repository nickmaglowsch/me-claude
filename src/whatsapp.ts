import { Client, LocalAuth, Message, Chat } from 'whatsapp-web.js';
import { RawMessage } from './extract';

export function createClient(): Client {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: 'data/session/' }),
    // Chromium flags required on Ubuntu 23.10+ where unprivileged user
    // namespaces are restricted by AppArmor (otherwise: "No usable sandbox!").
    // protocolTimeout is bumped to 5 min because client.getChats() can take
    // >30s (the default) for accounts with hundreds of chats — the call
    // evaluates JS inside the WhatsApp Web page to enumerate every chat.
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      protocolTimeout: 300000,
    },
  });

  client.on('qr', (qr: string) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('qrcode-terminal').generate(qr, { small: true });
  });

  client.on('auth_failure', (msg: string) => {
    console.error('Authentication failure:', msg);
    process.exit(1);
  });

  return client;
}

export function waitForReady(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('WhatsApp client did not become ready within 120s'));
    }, 120000);

    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function fetchAllChats(client: Client): Promise<Chat[]> {
  return client.getChats();
}

export async function fetchGroupChats(client: Client): Promise<Chat[]> {
  const chats = await client.getChats();
  return chats.filter(chat => chat.isGroup);
}

export async function fetchMessages(chat: Chat, limit = 500): Promise<Message[]> {
  return chat.fetchMessages({ limit });
}

export function formatMessageLine(msg: Message, senderName: string): string {
  const d = new Date(msg.timestamp * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}] ${senderName}: ${msg.body}`;
}

export function formatRawMessage(msg: Message): RawMessage {
  return {
    fromMe: msg.fromMe,
    type: msg.type,
    body: msg.body,
    author: msg.author ?? undefined,
    timestamp: msg.timestamp,
  };
}

export function getOwnerName(client: Client): string {
  return client.info.pushname || 'Owner';
}

export function getOwnerId(client: Client): string {
  return client.info.wid._serialized;
}

// Resolve a display name for a message sender without throwing.
// whatsapp-web.js's getContact() can blow up with
// "getAlternateUserWid - Invalid get call using deviceWid" for certain @lid
// senders; when that happens we fall back to the digits from author/from so
// a single bad contact doesn't abort the surrounding Promise.all batch.
export async function resolveSenderName(msg: any): Promise<string> {
  try {
    const contact = await msg.getContact();
    const name = contact?.pushname || contact?.number;
    if (name) return name;
  } catch {
    // fall through to id-based fallback
  }
  const rawId = msg?.author ?? msg?.from ?? '';
  const prefix = String(rawId).split('@')[0];
  return prefix || 'Unknown';
}
