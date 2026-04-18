import 'dotenv/config';
import fs from 'fs';
import type { EventBase, EventKind } from './events';

export type StatsWindow = '24h' | '7d' | '30d' | 'all';

export function parseWindow(raw: string): StatsWindow {
  if (raw === '24h' || raw === '7d' || raw === '30d' || raw === 'all') return raw;
  return '24h';
}

function windowCutoff(window: StatsWindow): number {
  const now = Date.now();
  switch (window) {
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d':  return now - 7  * 24 * 60 * 60 * 1000;
    case '30d': return now - 30 * 24 * 60 * 60 * 1000;
    case 'all': return 0;
  }
}

// Skip-kind suffix extraction: 'skip.rate_limited' → 'rate_limited'
function skipReason(kind: EventKind): string {
  return kind.replace('skip.', '');
}

function isSkipKind(kind: EventKind): boolean {
  return kind.startsWith('skip.');
}

export interface StatsResult {
  window: StatsWindow;
  replyCount: number;
  silentCount: number;
  byTrigger: Record<string, number>;
  byGroup: Record<string, number>;
  skipTotal: number;
  skipByReason: Record<string, number>;
  errorCount: number;
  lastError: { reason: string; time: string } | null;
  memoryWritten: number;
  memoryRejected: number;
  hasBootstrapEvents: boolean;
  bootstrapWritten: number;
  bootstrapSkipped: number;
  claudeCallCount: number;
  claudeDurationAvgMs: number | null;
  claudeDurationP50: number | null;
  claudeDurationP95: number | null;
  claudeDurationP99: number | null;
  claudeSlowest: { durationMs: number; chat: string; time: string } | null;
  commandExecuted: number;
  commandFailed: number;
  lastCommand: { text: string; time: string } | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

export function computeStats(eventsFilePath: string, window: StatsWindow): StatsResult {
  const cutoff = windowCutoff(window);

  const result: StatsResult = {
    window,
    replyCount: 0,
    silentCount: 0,
    byTrigger: {},
    byGroup: {},
    skipTotal: 0,
    skipByReason: {},
    errorCount: 0,
    lastError: null,
    memoryWritten: 0,
    memoryRejected: 0,
    hasBootstrapEvents: false,
    bootstrapWritten: 0,
    bootstrapSkipped: 0,
    claudeCallCount: 0,
    claudeDurationAvgMs: null,
    claudeDurationP50: null,
    claudeDurationP95: null,
    claudeDurationP99: null,
    claudeSlowest: null,
    commandExecuted: 0,
    commandFailed: 0,
    lastCommand: null,
  };

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(eventsFilePath, 'utf8');
  } catch {
    // File doesn't exist — return empty stats
    return result;
  }

  const lines = fileContent.split('\n').filter(l => l.trim().length > 0);
  const claudeDurations: number[] = [];

  for (const line of lines) {
    let event: EventBase;
    try {
      event = JSON.parse(line) as EventBase;
    } catch {
      console.warn('[stats] skipping malformed line:', line.slice(0, 80));
      continue;
    }

    // Window filter
    const eventTs = new Date(event.ts).getTime();
    if (isNaN(eventTs) || eventTs < cutoff) continue;

    switch (event.kind) {
      case 'reply.sent': {
        result.replyCount++;
        if (event.trigger) {
          result.byTrigger[event.trigger] = (result.byTrigger[event.trigger] ?? 0) + 1;
        }
        if (event.chat) {
          result.byGroup[event.chat] = (result.byGroup[event.chat] ?? 0) + 1;
        }
        break;
      }
      case 'reply.silent': {
        result.silentCount++;
        break;
      }
      case 'error': {
        result.errorCount++;
        const timeStr = new Date(event.ts).toTimeString().slice(0, 5);
        result.lastError = {
          reason: (event.reason as string) ?? 'unknown',
          time: timeStr,
        };
        break;
      }
      case 'memory.written': {
        result.memoryWritten++;
        break;
      }
      case 'memory.rejected': {
        result.memoryRejected++;
        break;
      }
      case 'bootstrap.contact_written': {
        result.hasBootstrapEvents = true;
        result.bootstrapWritten++;
        break;
      }
      case 'bootstrap.contact_skipped': {
        result.hasBootstrapEvents = true;
        result.bootstrapSkipped++;
        break;
      }
      case 'claude.call': {
        result.claudeCallCount++;
        if (typeof event.duration_ms === 'number') {
          claudeDurations.push(event.duration_ms);
          if (
            result.claudeSlowest === null ||
            event.duration_ms > result.claudeSlowest.durationMs
          ) {
            result.claudeSlowest = {
              durationMs: event.duration_ms,
              chat: (event.chat as string) ?? 'unknown',
              time: new Date(event.ts).toTimeString().slice(0, 5),
            };
          }
        }
        break;
      }
      case 'command.executed': {
        result.commandExecuted++;
        const timeStr = new Date(event.ts).toTimeString().slice(0, 5);
        result.lastCommand = {
          text: (event.command as string) ?? '(unknown)',
          time: timeStr,
        };
        break;
      }
      case 'command.failed': {
        result.commandFailed++;
        break;
      }
      default: {
        // Handle skip kinds
        if (isSkipKind(event.kind as EventKind)) {
          result.skipTotal++;
          const reason = skipReason(event.kind as EventKind);
          result.skipByReason[reason] = (result.skipByReason[reason] ?? 0) + 1;
        }
        break;
      }
    }
  }

  // Compute duration percentiles
  if (claudeDurations.length > 0) {
    const sorted = [...claudeDurations].sort((a, b) => a - b);
    const total = sorted.reduce((s, v) => s + v, 0);
    result.claudeDurationAvgMs = total / sorted.length;
    result.claudeDurationP50 = percentile(sorted, 50);
    result.claudeDurationP95 = percentile(sorted, 95);
    result.claudeDurationP99 = percentile(sorted, 99);
  }

  return result;
}

function pad(label: string, width = 22): string {
  return label.padEnd(width);
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatStats(stats: StatsResult, window: StatsWindow): string {
  const lines: string[] = [];

  lines.push(`=== WhatsApp bot stats (window: ${window}) ===`);
  lines.push('');

  // Replies
  lines.push(`${pad('Replies:')}${stats.replyCount}`);
  if (Object.keys(stats.byTrigger).length > 0) {
    const triggerStr = Object.entries(stats.byTrigger)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`  ${pad('by trigger:', 20)}${triggerStr}`);
  }
  if (Object.keys(stats.byGroup).length > 0) {
    const groupStr = Object.entries(stats.byGroup)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`  ${pad('by group:', 20)}${groupStr}`);
  }

  lines.push(`${pad('Silent (empty):')}${stats.silentCount}`);

  // Skips
  lines.push(`${pad('Skips (total):')}${stats.skipTotal}`);
  if (Object.keys(stats.skipByReason).length > 0) {
    const reasonStr = Object.entries(stats.skipByReason)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`  ${pad('by reason:', 20)}${reasonStr}`);
  }

  // Errors
  lines.push(`${pad('Errors:')}${stats.errorCount}`);
  if (stats.lastError) {
    lines.push(`  ${pad('Most recent:', 20)}"${stats.lastError.reason}" @ ${stats.lastError.time}`);
  }

  lines.push('');

  // Memory
  lines.push(`${pad('Memory updates:')}${stats.memoryWritten} written, ${stats.memoryRejected} rejected`);

  // Bootstrap
  if (stats.hasBootstrapEvents) {
    lines.push(`${pad('Bootstrap:')}${stats.bootstrapWritten} written, ${stats.bootstrapSkipped} skipped`);
  } else {
    lines.push(`${pad('Bootstrap:')}n/a (no bootstrap events in window)`);
  }

  lines.push('');

  // Claude calls
  lines.push(`${pad('Claude calls:')}${stats.claudeCallCount} total`);
  if (stats.claudeDurationAvgMs !== null) {
    lines.push(`  ${pad('avg duration:', 20)}${fmtMs(stats.claudeDurationAvgMs)}`);
  }
  if (
    stats.claudeDurationP50 !== null &&
    stats.claudeDurationP95 !== null &&
    stats.claudeDurationP99 !== null
  ) {
    lines.push(
      `  ${pad('p50 / p95 / p99:', 20)}${fmtMs(stats.claudeDurationP50)} / ${fmtMs(stats.claudeDurationP95)} / ${fmtMs(stats.claudeDurationP99)}`,
    );
  }
  if (stats.claudeSlowest) {
    const s = stats.claudeSlowest;
    lines.push(
      `  ${pad('slowest:', 20)}${fmtMs(s.durationMs)} in ${s.chat} @ ${s.time}`,
    );
  }

  lines.push('');

  // Commands
  lines.push(`${pad('Commands:')}${stats.commandExecuted} executed, ${stats.commandFailed} failed`);
  if (stats.lastCommand) {
    lines.push(`  ${pad('Most recent:', 20)}${stats.lastCommand.text} @ ${stats.lastCommand.time}`);
  }

  lines.push('');

  // Cost estimate
  lines.push(
    `${pad('Cost estimate:')}n/a (tokens not captured; run with --output-format json to enable)`,
  );

  return lines.join('\n');
}

// CLI entrypoint — only runs when executed directly, not when imported by tests
function main(): void {
  const args = process.argv.slice(2);
  let windowArg = '24h';
  const winIdx = args.findIndex(a => a.startsWith('--window'));
  if (winIdx !== -1) {
    const arg = args[winIdx];
    if (arg.includes('=')) {
      windowArg = arg.split('=')[1];
    } else if (args[winIdx + 1]) {
      windowArg = args[winIdx + 1];
    }
  }

  const window = parseWindow(windowArg);
  const eventsPath = require('path').join(process.cwd(), 'data', 'events.jsonl');
  const stats = computeStats(eventsPath, window);
  console.log(formatStats(stats, window));
}

// Only run main when this file is the entrypoint (not when imported by tests)
if (require.main === module) {
  main();
}
