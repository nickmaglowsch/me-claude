import fs from 'fs';
import path from 'path';

export type EventKind =
  | 'reply.sent'
  | 'reply.silent'
  | 'skip.not_in_group'
  | 'skip.from_me'
  | 'skip.not_mentioned'
  | 'skip.rate_limited'
  | 'skip.get_chat_failed'
  | 'skip.silenced'
  | 'command.received'
  | 'command.executed'
  | 'command.failed'
  | 'memory.written'
  | 'memory.rejected'
  | 'memory.git_failed'
  | 'bootstrap.contact_written'
  | 'bootstrap.contact_skipped'
  | 'claude.call'
  | 'error'
  | 'ambient.skipped'
  | 'ambient.considered'
  | 'ambient.replied'
  | 'ambient.declined'
  | 'skip.ambient_disabled';

export interface EventBase {
  ts: string;
  kind: EventKind;
  chat?: string;
  chat_id?: string;
  sender_name?: string;
  sender_jid?: string;
  trigger?: 'mention' | 'reply' | 'ambient';
  duration_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  reason?: string;
  [key: string]: unknown;
}

export const EVENTS_FILE = 'data/events.jsonl';

export function getEventsPath(): string {
  return path.join(process.cwd(), EVENTS_FILE);
}

export function logEvent(event: Omit<EventBase, 'ts'>): void {
  const entry = {
    ts: new Date().toISOString(),
    ...event,
  } as EventBase;
  const line = JSON.stringify(entry) + '\n';
  const eventsPath = getEventsPath();

  try {
    fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
    fs.appendFileSync(eventsPath, line, 'utf8');
  } catch (err) {
    console.warn('[events] failed to write event:', (err as Error).message, '| event kind:', event.kind);
  }
}
