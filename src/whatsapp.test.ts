import { describe, it, expect } from 'vitest';
import { formatMessageLine, formatRawMessage, getOwnerName, getOwnerId } from './whatsapp';

describe('formatMessageLine', () => {
  it('produces [HH:MM] SenderName: body with correct format', () => {
    // Use a known timestamp: 2024-01-01 00:00:00 UTC
    // In local time this may differ; we'll compute expected from Date
    const timestamp = 1704067200; // 2024-01-01 00:00:00 UTC
    const d = new Date(timestamp * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const msg = { timestamp, body: 'hello there' } as any;
    const result = formatMessageLine(msg, 'Alice');
    expect(result).toBe(`[${hh}:${mm}] Alice: hello there`);
  });

  it('zero-pads single-digit hours and minutes', () => {
    // Use a timestamp we know gives single-digit hour/minute
    // We'll find one: 2024-01-01 09:05:00 UTC in UTC offset 0
    // Instead, verify the format by checking the pattern
    const timestamp = 1704067200;
    const d = new Date(timestamp * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const msg = { timestamp, body: 'test' } as any;
    const result = formatMessageLine(msg, 'Bob');
    // Verify two-digit format with regex
    expect(result).toMatch(/^\[\d{2}:\d{2}\] Bob: test$/);
  });

  it('uses senderName parameter verbatim', () => {
    const msg = { timestamp: 1704067200, body: 'hi' } as any;
    const result = formatMessageLine(msg, 'MyCustomName');
    expect(result).toContain('MyCustomName');
  });

  it('uses msg.body verbatim', () => {
    const msg = { timestamp: 1704067200, body: 'exact body text' } as any;
    const result = formatMessageLine(msg, 'Sender');
    expect(result).toContain('exact body text');
  });
});

describe('formatRawMessage', () => {
  it('maps fromMe, type, body, timestamp correctly', () => {
    const msg = {
      fromMe: true,
      type: 'chat',
      body: 'hello',
      timestamp: 12345,
      author: undefined,
    } as any;
    const raw = formatRawMessage(msg);
    expect(raw.fromMe).toBe(true);
    expect(raw.type).toBe('chat');
    expect(raw.body).toBe('hello');
    expect(raw.timestamp).toBe(12345);
  });

  it('maps author when present', () => {
    const msg = { fromMe: false, type: 'chat', body: 'hi', timestamp: 1, author: 'author@c.us' } as any;
    const raw = formatRawMessage(msg);
    expect(raw.author).toBe('author@c.us');
  });

  it('sets author to undefined when msg.author is null/undefined', () => {
    const msg = { fromMe: true, type: 'chat', body: 'hi', timestamp: 1, author: null } as any;
    const raw = formatRawMessage(msg);
    expect(raw.author).toBeUndefined();
  });
});

describe('getOwnerName', () => {
  it('returns pushname when truthy', () => {
    const client = { info: { pushname: 'Alice' } } as any;
    expect(getOwnerName(client)).toBe('Alice');
  });

  it('returns "Owner" when pushname is empty string', () => {
    const client = { info: { pushname: '' } } as any;
    expect(getOwnerName(client)).toBe('Owner');
  });

  it('returns "Owner" when pushname is null/undefined', () => {
    const client = { info: { pushname: null } } as any;
    expect(getOwnerName(client)).toBe('Owner');
  });
});

describe('getOwnerId', () => {
  it('returns wid._serialized from client info', () => {
    const client = { info: { wid: { _serialized: '15551234567@c.us' } } } as any;
    expect(getOwnerId(client)).toBe('15551234567@c.us');
  });
});
