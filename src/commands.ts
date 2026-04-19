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
import {
  loadLimitsConfig,
  saveLimitsConfig,
  ensureDailyReset as ensureLimitsDailyReset,
  setDefaultLimit,
  setGroupLimit,
  getEffectiveLimit,
} from './limits';
import { loadFeedbackTopics } from './feedback-topics';
import { findGroupsByName, readDayMessages, localDate } from './groups';
import { callClaude } from './claude';
import { SUMMARY_PROMPT, fillTemplate } from './prompts';

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
  !topic add|remove|list <phrase> — manage the fuzzy-match topic bank
  !summary <group> [date]        — Summarize a group's day. date: today | yesterday | Nd | YYYY-MM-DD
  !limit <N> [group]             — cap replies/ambient per group per day. omit group for default.
  !limit off [group]             — clear the default (or a per-group override)
  !limit status                  — show current limits and today's counts`;

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
    // Length cap (applies to the whole phrase including any | separators)
    if (phrase.length > 64) {
      await ctx.reply(`phrase too long (${phrase.length} chars). Max 64.`);
      return;
    }
    // Alias group validation: if phrase contains |, validate each alias
    if (phrase.includes('|')) {
      const aliases = phrase.split('|');
      for (const alias of aliases) {
        if (alias.length === 0) {
          await ctx.reply('alias cannot be empty (found consecutive | or leading/trailing |).');
          return;
        }
        if (alias.length > 32) {
          await ctx.reply(`alias "${alias}" is too long (${alias.length} chars). Each alias max 32 chars.`);
          return;
        }
      }
    }
    // Bank size cap
    if (cfg.explicitTopics.length >= 200) {
      await ctx.reply(`topic bank full (${cfg.explicitTopics.length}/200 entries). Remove a topic first.`);
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
    const feedbackTopics = loadFeedbackTopics();
    const lines = [
      `topics (explicit, ${cfg.explicitTopics.length}): ${cfg.explicitTopics.join(', ') || '(none)'}`,
      `topics (voice, ${cfg.voiceProfileTopics.length}): ${cfg.voiceProfileTopics.join(', ') || '(none)'}`,
      `topics (memory, ${memoryTopics.length}): ${memoryTopics.join(', ') || '(none)'}`,
      `topics (feedback, ${feedbackTopics.length}): ${feedbackTopics.join(', ') || '(none)'}`,
    ];
    await ctx.reply(lines.join('\n'));
    return;
  }

  // Unknown sub-command
  await ctx.reply('usage: !topic add|remove|list <phrase>');
}

// ---------------------------------------------------------------------------
// !limit command handler
// ---------------------------------------------------------------------------

// Parse a non-negative integer string. Rejects "1.5", "-1", "abc", "", etc.
function parseNonNegativeInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function cmdLimit(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const first = parsed.argv[0];
  if (!first) {
    await ctx.reply(
      'usage: !limit <N> [group] | !limit off [group] | !limit status',
    );
    return;
  }

  const cfg = ensureLimitsDailyReset(loadLimitsConfig());

  if (first.toLowerCase() === 'status') {
    const defaultLine =
      cfg.defaultPerGroup === null
        ? 'default: unlimited'
        : `default: ${cfg.defaultPerGroup}/day per group`;
    const overrides = Object.entries(cfg.perGroup);
    const overrideLines =
      overrides.length === 0
        ? ['per-group overrides: none']
        : [
            'per-group overrides:',
            ...overrides.map(([g, n]) => `  ${g}: ${n}/day`),
          ];
    const countEntries = Object.entries(cfg.counts);
    const countLines =
      countEntries.length === 0
        ? ['today\'s counts: none']
        : [
            'today\'s counts:',
            ...countEntries.map(([g, c]) => {
              const lim = getEffectiveLimit(cfg, g);
              const limStr = lim === null ? '∞' : String(lim);
              return `  ${g}: ${c}/${limStr}`;
            }),
          ];
    await ctx.reply([defaultLine, ...overrideLines, ...countLines].join('\n'));
    return;
  }

  if (first.toLowerCase() === 'off') {
    const groupArg = parsed.argv.slice(1).join(' ').trim();
    if (!groupArg) {
      const updated = setDefaultLimit(cfg, null);
      saveLimitsConfig(updated);
      await ctx.reply('ok, default limit cleared (unlimited)');
      return;
    }
    const updated = setGroupLimit(cfg, groupArg, null);
    saveLimitsConfig(updated);
    await ctx.reply(`ok, cleared per-group limit for ${groupArg.toLowerCase().trim()}`);
    return;
  }

  const n = parseNonNegativeInt(first);
  if (n === null) {
    await ctx.reply('invalid limit: must be a non-negative integer (or use "off" / "status")');
    return;
  }

  const groupArg = parsed.argv.slice(1).join(' ').trim();
  if (!groupArg) {
    const updated = setDefaultLimit(cfg, n);
    saveLimitsConfig(updated);
    await ctx.reply(`ok, default limit set to ${n}/day per group`);
    return;
  }

  const updated = setGroupLimit(cfg, groupArg, n);
  saveLimitsConfig(updated);
  await ctx.reply(`ok, limit for ${groupArg.toLowerCase().trim()} set to ${n}/day`);
}

// ---------------------------------------------------------------------------
// parseDateSpec
// ---------------------------------------------------------------------------

/**
 * Parse user's date spec into a local YYYY-MM-DD string.
 * Accepts: "today" | undefined | "" → today
 *          "yesterday"              → yesterday
 *          /^\d+d$/                 → N days ago
 *          /^\d{4}-\d{2}-\d{2}$/   → exact date
 * Returns null if unrecognized.
 */
export function parseDateSpec(raw?: string): string | null {
  const s = (raw ?? '').trim();

  if (!s || s === 'today') {
    return localDate(Date.now());
  }

  if (s === 'yesterday') {
    return localDate(Date.now() - 24 * 60 * 60 * 1000);
  }

  const ndMatch = s.match(/^(\d+)d$/);
  if (ndMatch) {
    const n = parseInt(ndMatch[1], 10);
    return localDate(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  return null;
}

// ---------------------------------------------------------------------------
// !summary command handler
// ---------------------------------------------------------------------------

async function cmdSummary(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  logEvent({ kind: 'summary.requested' });

  const groupQuery = parsed.argv[0];
  if (!groupQuery) {
    await ctx.reply('usage: !summary <group> [date]   e.g. !summary mgz yesterday');
    return;
  }

  // Parse optional date spec (argv[1..] joined)
  const rawDate = parsed.argv.slice(1).join(' ');
  const targetDate = parseDateSpec(rawDate || undefined);
  if (targetDate === null) {
    await ctx.reply(`invalid date: "${rawDate}". Use: today, yesterday, Nd, or YYYY-MM-DD`);
    return;
  }

  // Fuzzy-match the group
  const matches = findGroupsByName(groupQuery);

  if (matches.length === 0) {
    logEvent({ kind: 'summary.no_match', query: groupQuery });
    await ctx.reply(`no group matching "${groupQuery}"`);
    return;
  }

  if (matches.length > 1) {
    logEvent({ kind: 'summary.multi_match', query: groupQuery, count: matches.length });
    const names = matches.map(m => m.name).join(', ');
    await ctx.reply(`multiple matches: ${names}. be more specific.`);
    return;
  }

  const match = matches[0];
  const messages = readDayMessages(match.folder, targetDate);

  if (messages.length === 0) {
    logEvent({ kind: 'summary.empty', group: match.name, date: targetDate });
    await ctx.reply(`no messages for ${match.name} on ${targetDate}`);
    return;
  }

  // Format messages for the prompt
  const messageLines = messages.map(m => {
    const d = new Date(m.ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const suffix = m.from_me ? ' (me)' : '';
    return `[${hh}:${mm}] ${m.from_name}: ${m.body}${suffix}`;
  }).join('\n');

  const prompt = fillTemplate(SUMMARY_PROMPT, {
    GROUP_NAME: match.name,
    DATE: targetDate,
    MESSAGES: messageLines,
  });

  const callStart = Date.now();
  try {
    const result = await callClaude(prompt);
    const duration = Date.now() - callStart;
    const summary = result.trim();

    if (!summary) {
      await ctx.reply('summary was empty');
      return;
    }

    logEvent({
      kind: 'summary.generated',
      group: match.name,
      date: targetDate,
      msg_count: messages.length,
      duration_ms: duration,
    });
    await ctx.reply(summary);
  } catch (e) {
    logEvent({ kind: 'summary.error', group: match.name, reason: (e as Error).message });
    await ctx.reply(`summary failed: ${(e as Error).message}`);
  }
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
      case 'summary':
        await cmdSummary(parsed, ctx);
        break;
      case 'limit':
        await cmdLimit(parsed, ctx);
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
