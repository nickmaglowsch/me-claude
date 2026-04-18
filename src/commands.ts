import fs from 'fs';
import path from 'path';
import { writeContactMemoryGuarded } from './memory';
import { computeStats, formatStats } from './stats';
import { logEvent } from './events';
import { getEventsPath } from './events';
import {
  loadAmbientConfig,
  saveAmbientConfig,
  ensureDailyReset,
  buildTopicBank,
  loadMemoryTopics,
  maybeRefreshVoiceProfileTopics,
} from './ambient';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandContext {
  ownerCusId: string;
  // Callback the dispatcher uses to send reply messages back into the self-chat.
  // Index.ts supplies this; tests supply a stub.
  reply: (text: string) => Promise<void>;
  // In-memory state: chat-name → muted-until-ms; "*" key for global mute.
  silences: Map<string, number>;
}

export interface ParsedCommand {
  name: string;   // e.g. "remember", "who", "status"
  argv: string[]; // tokens after the command name
  raw: string;    // full body after the leading "!"
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw message body as a bot command.
 *
 * Returns null when:
 * - The (trimmed) body doesn't start with "!"
 * - There is no command name after the "!" (e.g. body is just "!")
 */
export function parseCommand(body: string): ParsedCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('!')) return null;

  const withoutBang = trimmed.slice(1).trim();
  if (!withoutBang) return null;

  const tokens = withoutBang.split(/\s+/);
  const name = tokens[0];
  if (!name) return null;

  const argv = tokens.slice(1);
  const raw = withoutBang;

  return { name, argv, raw };
}

// ---------------------------------------------------------------------------
// Silence duration parser
// ---------------------------------------------------------------------------

/**
 * Parse a duration string like "2h", "30m", "1d" into milliseconds.
 * Returns null if the format is not recognised.
 */
function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)([mhd])$/);
  if (!m) return null;
  const value = parseInt(m[1], 10);
  switch (m[2]) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contact file path helper (dynamic — uses cwd at call time for testability)
// ---------------------------------------------------------------------------

function contactsDir(): string {
  return path.join(process.cwd(), 'data', 'contacts');
}

function contactFilePath(jid: string): string {
  return path.join(contactsDir(), `${jid}.md`);
}

// ---------------------------------------------------------------------------
// Silence key normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a chat name for use as a silence key: lowercase + trim.
 * The sentinel key '*' (global mute) is NOT normalized — callers skip it.
 */
export function normalizeChatKey(s: string): string {
  return s.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP_TEXT = `Commands available:
  !help                          — show this message
  !remember <jid> <fact...>      — append a fact to a contact's memory file
  !forget <jid>                  — delete a contact's memory file
  !who <jid|name>                — show a contact's memory file (or search by name)
  !status                        — show bot stats for the last 24h
  !silence <chat|all> <dur>      — mute a chat (or all chats); dur = Nm, Nh, Nd
  !resume                        — clear all silences
  !ambient on|off [chat]         — enable/disable ambient replies globally or per-chat
  !ambient status|cap|threshold  — show or change ambient config
  !ambient refresh               — re-extract topics from voice profile + memory
  !topic add|remove|list <phrase> — manage the fuzzy-match topic bank`;

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdHelp(ctx: CommandContext): Promise<void> {
  await ctx.reply(HELP_TEXT);
}

async function cmdRemember(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const jid = parsed.argv[0];
  if (!jid) {
    await ctx.reply('usage: !remember <jid> <fact...>');
    return;
  }
  const fact = parsed.argv.slice(1).join(' ');
  if (!fact) {
    await ctx.reply('usage: !remember <jid> <fact...>');
    return;
  }

  const filePath = contactFilePath(jid);
  let content: string;

  const existing = (() => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  })();

  const today = new Date().toISOString().slice(0, 10);

  if (existing === null) {
    // Create a minimal template for a brand-new contact
    content = `## Identity\n\n${jid}\n\n## Facts\n\n- ${fact}\n\n## Last updated\n\n${today}\n`;
  } else {
    // Split file into lines, find the ## Facts block and append there,
    // or add a new ## Facts section at the end.
    const lines = existing.split('\n');
    const factsIdx = lines.findIndex(l => l.trim() === '## Facts');

    if (factsIdx !== -1) {
      // Find the end of the Facts block (next ## header or EOF)
      let insertAt = lines.length;
      for (let i = factsIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('## ')) {
          // Insert before the next section (after any trailing blank lines of Facts)
          insertAt = i;
          break;
        }
      }
      // Trim trailing empty lines in the Facts block, then append new fact line
      while (insertAt > factsIdx + 1 && lines[insertAt - 1].trim() === '') {
        insertAt--;
      }
      lines.splice(insertAt, 0, `- ${fact}`);
    } else {
      // No ## Facts section — append one
      lines.push('', '## Facts', '', `- ${fact}`);
    }

    // Update ## Last updated or append it
    const lastUpdIdx = lines.findIndex(l => l.trim() === '## Last updated');
    if (lastUpdIdx !== -1) {
      // Replace the date line right after the header
      let dateLineIdx = lastUpdIdx + 1;
      while (dateLineIdx < lines.length && lines[dateLineIdx].trim() === '') {
        dateLineIdx++;
      }
      if (dateLineIdx < lines.length) {
        lines[dateLineIdx] = today;
      } else {
        lines.push('', today);
      }
    } else {
      lines.push('', '## Last updated', '', today);
    }

    content = lines.join('\n');
    // Ensure single trailing newline
    content = content.trimEnd() + '\n';
  }

  const result = await writeContactMemoryGuarded(jid, content, { reason: 'command !remember' });
  if (result.status === 'rejected') {
    await ctx.reply(`error: memory write rejected (${result.reason ?? 'unknown'})`);
    return;
  }
  await ctx.reply(`ok, remembered: ${fact} for ${jid}${result.status === 'committed' ? '' : ' (not git-committed)'}`);
}

async function cmdForget(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const jid = parsed.argv[0];
  if (!jid) {
    await ctx.reply('usage: !forget <jid>');
    return;
  }
  const filePath = contactFilePath(jid);
  try {
    fs.unlinkSync(filePath);
    await ctx.reply(`ok, forgot ${jid}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      await ctx.reply(`no file for ${jid}`);
    } else {
      throw err;
    }
  }
}

async function cmdWho(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const arg = parsed.argv[0];
  if (!arg) {
    await ctx.reply('usage: !who <jid|name>');
    return;
  }

  const MAX_CHARS = 3000;

  if (arg.endsWith('@c.us') || arg.endsWith('@lid') || arg.endsWith('@g.us')) {
    // Treat as a direct JID
    const filePath = contactFilePath(arg);
    try {
      let content = fs.readFileSync(filePath, 'utf8');
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS) + '\n...(truncated)';
      }
      await ctx.reply(content);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await ctx.reply(`no memory file for ${arg}`);
      } else {
        throw err;
      }
    }
    return;
  }

  // Name search — case-insensitive grep through all contact files
  const dir = contactsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  } catch {
    files = [];
  }

  const nameLC = arg.toLowerCase();
  const matches: Array<{ jid: string; content: string }> = [];

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      if (content.toLowerCase().includes(nameLC)) {
        // jid = filename without ".md"
        const jid = file.slice(0, -3);
        matches.push({ jid, content });
      }
    } catch {
      // skip unreadable files
    }
  }

  if (matches.length === 0) {
    await ctx.reply(`no match for "${arg}"`);
  } else if (matches.length === 1) {
    let content = matches[0].content;
    if (content.length > MAX_CHARS) {
      content = content.slice(0, MAX_CHARS) + '\n...(truncated)';
    }
    await ctx.reply(content);
  } else {
    const list = matches.map(m => m.jid).join('\n  ');
    await ctx.reply(
      `multiple matches for "${arg}". Use the JID directly:\n  ${list}`,
    );
  }
}

async function cmdStatus(ctx: CommandContext): Promise<void> {
  const eventsPath = getEventsPath();
  const stats = computeStats(eventsPath, '24h');
  const summary = formatStats(stats, '24h');
  await ctx.reply(summary);
}

async function cmdSilence(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const chatArg = parsed.argv[0];
  const durationArg = parsed.argv[1];

  if (!chatArg || !durationArg) {
    await ctx.reply('usage: !silence <chat|all> <duration>  (e.g. !silence mgz 2h)');
    return;
  }

  const ms = parseDuration(durationArg);
  if (ms === null) {
    await ctx.reply('invalid duration. Examples: 30m, 2h, 1d');
    return;
  }

  const key = chatArg === 'all' ? '*' : normalizeChatKey(chatArg);
  const muteUntil = Date.now() + ms;
  ctx.silences.set(key, muteUntil);

  const until = new Date(muteUntil).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const label = key === '*' ? 'all chats' : chatArg;
  await ctx.reply(`ok, silenced ${label} until ${until}`);
}

async function cmdResume(ctx: CommandContext): Promise<void> {
  ctx.silences.clear();
  await ctx.reply('ok, resumed');
}

// ---------------------------------------------------------------------------
// !ambient command handler
// ---------------------------------------------------------------------------

async function cmdAmbient(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const sub = parsed.argv[0]?.toLowerCase();
  const arg = parsed.argv[1];

  // Load config, run daily reset before reading any state
  const cfg = ensureDailyReset(loadAmbientConfig());

  if (sub === 'on') {
    if (arg) {
      // !ambient on <chat> — remove from disabledGroups
      const key = normalizeChatKey(arg);
      const updated = {
        ...cfg,
        disabledGroups: cfg.disabledGroups.filter(g => normalizeChatKey(g) !== key),
      };
      saveAmbientConfig(updated);
      await ctx.reply(`ok, re-enabled ambient in ${key}`);
    } else {
      // !ambient on — enable globally
      const disabledList =
        cfg.disabledGroups.length > 0 ? cfg.disabledGroups.join(', ') : 'none';
      const updated = { ...cfg, masterEnabled: true };
      saveAmbientConfig(updated);
      await ctx.reply(`ok, ambient on. applies to all groups except: ${disabledList}`);
    }
    return;
  }

  if (sub === 'off') {
    if (arg) {
      // !ambient off <chat> — add to disabledGroups (no duplicate)
      const key = normalizeChatKey(arg);
      const alreadyDisabled = cfg.disabledGroups.some(g => normalizeChatKey(g) === key);
      const updated = {
        ...cfg,
        disabledGroups: alreadyDisabled
          ? cfg.disabledGroups
          : [...cfg.disabledGroups, key],
      };
      saveAmbientConfig(updated);
      await ctx.reply(`ok, disabled ambient in ${key}`);
    } else {
      // !ambient off — master kill switch
      const updated = { ...cfg, masterEnabled: false };
      saveAmbientConfig(updated);
      await ctx.reply('ok, ambient off globally');
    }
    return;
  }

  if (sub === 'status') {
    const memoryTopics = loadMemoryTopics();
    const topicBank = buildTopicBank(cfg, memoryTopics);
    const voiceProfileTopics = cfg.voiceProfileTopics;
    const lines = [
      `ambient master: ${cfg.masterEnabled ? 'on' : 'off'}`,
      `disabled groups: ${cfg.disabledGroups.length > 0 ? cfg.disabledGroups.join(', ') : 'none'}`,
      `daily cap: ${cfg.dailyCap}`,
      `threshold: ${cfg.confidenceThreshold}`,
      `replies today: ${cfg.repliesToday.length}`,
      `topics: explicit=${cfg.explicitTopics.length} voice=${voiceProfileTopics.length} memory=${memoryTopics.length} bank=${topicBank.length}`,
    ];
    await ctx.reply(lines.join('\n'));
    return;
  }

  if (sub === 'cap') {
    const n = parseInt(arg ?? '', 10);
    if (isNaN(n) || n <= 0 || String(n) !== (arg ?? '').trim()) {
      await ctx.reply('invalid cap: must be a positive integer');
      return;
    }
    const updated = { ...cfg, dailyCap: n };
    saveAmbientConfig(updated);
    await ctx.reply(`ok, daily cap set to ${n}`);
    return;
  }

  if (sub === 'threshold') {
    const n = parseFloat(arg ?? '');
    if (isNaN(n) || n < 0 || n > 1) {
      await ctx.reply('invalid threshold: must be a number between 0 and 1');
      return;
    }
    const updated = { ...cfg, confidenceThreshold: n };
    saveAmbientConfig(updated);
    await ctx.reply(`ok, threshold set to ${n}`);
    return;
  }

  if (sub === 'refresh') {
    const voiceResult = await maybeRefreshVoiceProfileTopics();
    // Reload config after voice refresh in case it was updated
    const cfgAfter = ensureDailyReset(loadAmbientConfig());
    const memoryTopics = loadMemoryTopics();
    const topicBank = buildTopicBank(cfgAfter, memoryTopics);
    await ctx.reply(
      `ok, refreshed: voice=${voiceResult.count} memory=${memoryTopics.length} total=${topicBank.length}`,
    );
    return;
  }

  // Unknown sub-command
  await ctx.reply('usage: !ambient on|off [chat] | status | cap <n> | threshold <n> | refresh');
}

// ---------------------------------------------------------------------------
// !topic command handler
// ---------------------------------------------------------------------------

async function cmdTopic(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const sub = parsed.argv[0]?.toLowerCase();
  const phrase = parsed.argv.slice(1).join(' ').trim().toLowerCase();

  // Load config, run daily reset before reading any state
  const cfg = ensureDailyReset(loadAmbientConfig());

  if (sub === 'add') {
    if (!phrase) {
      await ctx.reply('usage: !topic add <phrase>');
      return;
    }
    const alreadyExists = cfg.explicitTopics.some(t => t.toLowerCase() === phrase);
    if (!alreadyExists) {
      const updated = { ...cfg, explicitTopics: [...cfg.explicitTopics, phrase] };
      saveAmbientConfig(updated);
      await ctx.reply(`ok, added ${phrase}. total: ${updated.explicitTopics.length}`);
    } else {
      await ctx.reply(`already in list: ${phrase}. total: ${cfg.explicitTopics.length}`);
    }
    return;
  }

  if (sub === 'remove') {
    if (!phrase) {
      await ctx.reply('usage: !topic remove <phrase>');
      return;
    }
    const exists = cfg.explicitTopics.some(t => t.toLowerCase() === phrase);
    if (!exists) {
      await ctx.reply(`not in list: ${phrase}`);
      return;
    }
    const updated = {
      ...cfg,
      explicitTopics: cfg.explicitTopics.filter(t => t.toLowerCase() !== phrase),
    };
    saveAmbientConfig(updated);
    await ctx.reply(`ok, removed ${phrase}`);
    return;
  }

  if (sub === 'list') {
    const memoryTopics = loadMemoryTopics();
    const lines = [
      `topics (explicit, ${cfg.explicitTopics.length}): ${cfg.explicitTopics.join(', ') || '(none)'}`,
      `topics (voice, ${cfg.voiceProfileTopics.length}): ${cfg.voiceProfileTopics.join(', ') || '(none)'}`,
      `topics (memory, ${memoryTopics.length}): ${memoryTopics.join(', ') || '(none)'}`,
    ];
    await ctx.reply(lines.join('\n'));
    return;
  }

  // Unknown sub-command
  await ctx.reply('usage: !topic add|remove|list <phrase>');
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Execute a parsed command. Always replies via ctx.reply.
 * Catches errors internally; never throws.
 */
export async function dispatchCommand(
  parsed: ParsedCommand,
  ctx: CommandContext,
): Promise<void> {
  try {
    logEvent({ kind: 'command.received', command: parsed.name });

    switch (parsed.name) {
      case 'help':
        await cmdHelp(ctx);
        break;
      case 'remember':
        await cmdRemember(parsed, ctx);
        break;
      case 'forget':
        await cmdForget(parsed, ctx);
        break;
      case 'who':
        await cmdWho(parsed, ctx);
        break;
      case 'status':
        await cmdStatus(ctx);
        break;
      case 'silence':
        await cmdSilence(parsed, ctx);
        break;
      case 'resume':
        await cmdResume(ctx);
        break;
      case 'ambient':
        await cmdAmbient(parsed, ctx);
        break;
      case 'topic':
        await cmdTopic(parsed, ctx);
        break;
      default:
        await ctx.reply(`unknown command: ${parsed.name}. try !help`);
        break;
    }

    logEvent({ kind: 'command.executed', command: parsed.name });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error(`[commands] error in !${parsed.name}:`, err);
    try {
      await ctx.reply(`error: ${message}`);
    } catch {
      // If even the reply fails, swallow silently to avoid crashes
    }
    logEvent({ kind: 'command.failed', command: parsed.name, reason: message });
  }
}
