import type { Command } from 'commander';
import { withApp, printTable } from './util.js';
import { rowToCompact } from '../../core/normalize.js';

export function register(program: Command): void {
  program
    .command('threads <room>')
    .description('List threads in a room')
    .option('-n, --count <n>', 'number of threads to show', '25')
    .option('--text <filter>', 'filter by text')
    .option('--json', 'output as compact JSON records')
    .action(
      async (
        room: string,
        opts: { count: string; text?: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const count = Math.max(1, parseInt(opts.count, 10) || 25);
          const roomRow = await app.rooms.resolve(room);

          await app.sync.ensureRoomSynced(roomRow.rid);
          await app.sync.seedThreadParents(roomRow.rid);

          const rows = app.db.getThreadParents(roomRow.rid, {
            limit: count,
            textLike: opts.text,
          });

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(JSON.stringify(rows.map((r) => rowToCompact(r))) + '\n');
            return;
          }

          if (rows.length === 0) {
            process.stdout.write('No threads found.\n');
            return;
          }

          const tableRows: string[][] = [];
          for (const r of rows) {
            const date = r.ts
              ? new Date(r.ts).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
              : '??/??/??';
            const author = r.author_username ?? r.author_name ?? r.author_id ?? '?';
            const snippet = (r.text ?? '').slice(0, 60);
            const replies = r.tcount ?? 0;
            const last = r.tlm
              ? new Date(r.tlm).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              : '??:??';
            tableRows.push([
              `[${date}]`,
              `@${author}:`,
              `${snippet}`,
              `(${replies} ${replies === 1 ? 'reply' : 'replies'}, last ${last}, id: ${r.id})`,
            ]);
          }
          printTable(tableRows);
        });
      },
    );

  program
    .command('thread <id>')
    .description('Show a thread by its parent message id')
    .option('-n, --count <n>', 'number of replies to show', '50')
    .option('--json', 'output as compact JSON records')
    .action(
      async (
        id: string,
        opts: { count: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const count = Math.max(1, parseInt(opts.count, 10) || 50);
          const parent = await app.sync.ensureThreadLoaded(id);

          const messages = app.db.getThreadMessages(id, { limit: count });

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(
              JSON.stringify({ parent: rowToCompact(parent), messages: messages.map((r) => rowToCompact(r)) }) + '\n',
            );
            return;
          }

          const fmt = (r: typeof parent) => {
            const time = r.ts
              ? new Date(r.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              : '??:??';
            const author = r.author_username ?? r.author_name ?? r.author_id ?? '?';
            return `[${time}] @${author}: ${r.text ?? ''}`;
          };

          process.stdout.write(fmt(parent) + '\n');
          for (const r of messages) {
            process.stdout.write('  ' + fmt(r) + '\n');
          }
        });
      },
    );
}
