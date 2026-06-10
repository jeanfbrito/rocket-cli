import type { Command } from 'commander';
import { withApp } from './util.js';
import {
  collectAttention,
  type AttentionItem,
  type AttentionReport,
  type AttentionThread,
} from '../../core/attention.js';
import type { CompactMessage } from '../../core/types.js';

/** [date HH:MM] @author: text line for a single compact message. */
function messageLine(m: CompactMessage, indent = ''): string {
  const d = m.time ? new Date(m.time) : null;
  const stamp = d
    ? `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : '????-??-?? ??:??';
  return `${indent}[${stamp}] @${m.author}: ${m.text}`;
}

const sigil = (type: string): string => (type === 'dm' ? '@' : '#');

/** Group flat items by room id, preserving first-seen room order. */
function byRoom(items: AttentionItem[]): Array<{ room: AttentionItem['room']; items: AttentionItem[] }> {
  const order: string[] = [];
  const map = new Map<string, { room: AttentionItem['room']; items: AttentionItem[] }>();
  for (const it of items) {
    let bucket = map.get(it.room.id);
    if (!bucket) {
      bucket = { room: it.room, items: [] };
      map.set(it.room.id, bucket);
      order.push(it.room.id);
    }
    bucket.items.push(it);
  }
  return order.map((id) => map.get(id)!);
}

function printItemSection(header: string, items: AttentionItem[]): void {
  if (items.length === 0) return;
  const out = process.stdout;
  out.write(`\n▌ ${header}\n`);
  for (const { room, items: roomItems } of byRoom(items)) {
    out.write(`  ${sigil(room.type)}${room.name}\n`);
    for (const it of roomItems) {
      const flag = it.alsoUnread ? ' (also unread)' : '';
      out.write(messageLine(it.message, '    ') + flag + '\n');
      if (it.message.link) out.write(`      ${it.message.link}\n`);
    }
  }
}

function printThreadSection(header: string, threads: AttentionThread[]): void {
  if (threads.length === 0) return;
  const out = process.stdout;
  out.write(`\n▌ ${header}\n`);
  for (const t of threads) {
    const preview = (t.parent.text || '(no text)').slice(0, 60);
    out.write(`  ${sigil(t.room.type)}${t.room.name} ↳ ${preview}\n`);
    for (const reply of t.messages) {
      out.write(messageLine(reply, '    ') + '\n');
      if (reply.link) out.write(`      ${reply.link}\n`);
    }
  }
}

function printHuman(report: AttentionReport): void {
  const out = process.stdout;
  if (report.totals.all === 0) {
    out.write('Nothing needs your attention.\n');
    return;
  }

  printItemSection('MENTIONS', report.mentions);
  printItemSection('DIRECT MESSAGES', report.directUnreads);
  printThreadSection('THREADS', report.threadUnreads);
  printItemSection('CHANNELS', report.channelUnreads);

  const t = report.totals;
  out.write(
    `\n${t.all} item${t.all === 1 ? '' : 's'} need your attention: ` +
      `${t.mentions} mention${t.mentions === 1 ? '' : 's'}, ` +
      `${t.directUnreads} DM${t.directUnreads === 1 ? '' : 's'}, ` +
      `${t.threadUnreads} thread${t.threadUnreads === 1 ? '' : 's'}, ` +
      `${t.channelUnreads} channel${t.channelUnreads === 1 ? '' : 's'} ` +
      `(since ${report.searchedSince}).\n`,
  );
}

export function register(program: Command): void {
  program
    .command('attention')
    .description(
      'One-call triage of everything needing your attention: mentions, unread ' +
        'DMs, unread threads, unread channels — prioritized, deduplicated (read-only)',
    )
    .option('--since-days <n>', 'how far back to look for mentions, in days', '7')
    .option('--limit <n>', 'max items per section', '30')
    .option('--all-broadcasts', 'also include channel-wide @all/@here mentions')
    .option('--json', 'output as a structured JSON report')
    .action(
      async (
        opts: {
          sinceDays: string;
          limit: string;
          allBroadcasts?: boolean;
          json?: boolean;
        },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const sinceDays = Math.max(1, parseInt(opts.sinceDays, 10) || 7);
          const limitPerSection = Math.max(1, parseInt(opts.limit, 10) || 30);
          const includeChannelWide = opts.allBroadcasts === true;

          const report = await collectAttention(app, {
            sinceDays,
            limitPerSection,
            includeChannelWide,
          });

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(JSON.stringify(report) + '\n');
            return;
          }

          printHuman(report);
        });
      },
    );
}
