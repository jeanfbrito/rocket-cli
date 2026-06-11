import type { Command } from 'commander';
import { withApp } from './util.js';
import { collectUnread, type UnreadReport } from '../../core/unread.js';
import type { CompactMessage } from '../../core/types.js';

/** [HH:MM] @author: text line for a single compact message. */
function messageLine(m: CompactMessage, indent = ''): string {
  const time = m.time
    ? new Date(m.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : '??:??';
  return `${indent}[${time}] @${m.author}: ${m.text}`;
}

function printHuman(report: UnreadReport): void {
  const out = process.stdout;
  if (report.rooms.length === 0) {
    out.write('All caught up. Nothing unread.\n');
    return;
  }

  for (const r of report.rooms) {
    const threadCount = r.unreadThreads.length;
    // Activity-only rooms carry no server unread count (mentions-only server):
    // label them by their actual sliced message count instead of "0 unread".
    const parts = r.activityOnly
      ? [`${r.messages.length} new (activity)`]
      : [`${r.unreadCount} unread`];
    if (threadCount > 0) {
      parts.push(`${threadCount} ${threadCount === 1 ? 'thread' : 'threads'}`);
    }
    // A hidden room ("Hide unread counter" on) is only surfaced because the user
    // is mentioned — label it so the count isn't read as ordinary unread.
    if (r.hiddenMentioned) {
      parts.push('hidden room, mentioned');
    }
    const sigil = r.room.type === 'dm' ? '@' : '#';
    out.write(`\n── ${sigil}${r.room.name} (${parts.join(', ')}) ──\n`);
    if (r.approximate) {
      out.write('   (no read marker for this room — showing newest as an approximation)\n');
    }

    for (const m of r.messages) {
      out.write(messageLine(m) + '\n');
    }

    for (const t of r.unreadThreads) {
      const preview = (t.parent.text || '(no text)').slice(0, 50);
      out.write(`  ↳ thread: ${preview}\n`);
      for (const reply of t.messages) {
        out.write(messageLine(reply, '    ') + '\n');
      }
    }
  }

  const { rooms, messages, threads } = report.totals;
  out.write(
    `\n${messages} unread message${messages === 1 ? '' : 's'} across ${rooms} room${
      rooms === 1 ? '' : 's'
    }${threads > 0 ? `, ${threads} thread${threads === 1 ? '' : 's'}` : ''}.\n`,
  );
}

export function register(program: Command): void {
  program
    .command('unread')
    .description('Show everything unread since you last read each room (read-only)')
    .option('--limit <n>', 'max messages per room', '50')
    .option('--no-threads', 'skip unread thread replies')
    .option(
      '--all',
      'also include rooms whose "Hide unread counter" setting is on ' +
        '(default matches the UI: hidden rooms appear only when you are mentioned)',
    )
    .option('--json', 'output as a structured JSON report')
    .action(
      async (
        opts: { limit: string; threads?: boolean; all?: boolean; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const limitPerRoom = Math.max(1, parseInt(opts.limit, 10) || 50);
          // commander sets `threads` to false when --no-threads is passed;
          // default (flag absent) is true.
          const includeThreads = opts.threads !== false;
          const includeHidden = opts.all === true;

          const report = await collectUnread(app, {
            limitPerRoom,
            includeThreads,
            includeHidden,
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
