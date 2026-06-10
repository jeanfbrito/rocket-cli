import type { Command } from 'commander';
import { withApp } from './util.js';
import { collectMentions, type MentionsReport } from '../../core/mentions.js';
import type { CompactMessage } from '../../core/types.js';

/** [date HH:MM] @author: text line for a single compact message. */
function messageLine(m: CompactMessage): string {
  const d = m.time ? new Date(m.time) : null;
  const stamp = d
    ? `${d.toLocaleDateString('en-GB')} ${d.toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : '????-??-?? ??:??';
  return `[${stamp}] @${m.author}: ${m.text}`;
}

function printHuman(report: MentionsReport): void {
  const out = process.stdout;
  if (report.mentions.length === 0) {
    out.write('No mentions. Nothing needs your attention.\n');
    return;
  }

  for (const r of report.mentions) {
    const count = r.messages.length;
    const sigil = r.room.type === 'dm' ? '@' : '#';
    out.write(
      `\n── ${sigil}${r.room.name} (${count} mention${count === 1 ? '' : 's'}) ──\n`,
    );
    for (const m of r.messages) {
      out.write(messageLine(m) + '\n');
      if (m.link) out.write(`   ${m.link}\n`);
    }
  }

  const { rooms, messages } = report.totals;
  out.write(
    `\n${messages} mention${messages === 1 ? '' : 's'} across ${rooms} room${
      rooms === 1 ? '' : 's'
    } (since ${report.searchedSince}).\n`,
  );
}

export function register(program: Command): void {
  program
    .command('mentions')
    .description('Show messages that mention you across all cached rooms (read-only)')
    .option('--since-days <n>', 'how far back to look, in days', '7')
    .option('--limit <n>', 'max total mentions to show', '50')
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
          const limit = Math.max(1, parseInt(opts.limit, 10) || 50);
          const includeChannelWide = opts.allBroadcasts === true;

          const report = await collectMentions(app, {
            sinceDays,
            limit,
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
