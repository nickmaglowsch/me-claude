export interface RawMessage {
  fromMe: boolean;
  type: string;      // message type: 'chat', 'image', 'sticker', etc.
  body: string;
  author?: string;   // group message author identifier (JID)
  timestamp: number; // unix seconds
}

export function filterMessages(messages: RawMessage[]): RawMessage[] {
  return messages.filter(msg =>
    msg.fromMe === true &&
    msg.type === 'chat' &&
    msg.body.trim().length >= 3 &&
    msg.body.trim() !== '<Media omitted>'
  );
}

export function stratifiedSampleByChat(perChatMessages: RawMessage[][], perChatMax = 50): RawMessage[] {
  const result: RawMessage[] = [];
  for (const chatMsgs of perChatMessages) {
    result.push(...chatMsgs.slice(0, perChatMax));
  }
  return result;
}

export function shuffle(messages: RawMessage[]): RawMessage[] {
  const arr = [...messages];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function checkMinimumVolume(messages: RawMessage[]): void {
  if (messages.length < 100) {
    throw new Error('Not enough message history to build a reliable voice profile.');
  }
}

export function formatMessagesForPrompt(messages: RawMessage[]): string {
  if (messages.length === 0) return '';
  return messages.map(m => m.body).join('\n---\n');
}
