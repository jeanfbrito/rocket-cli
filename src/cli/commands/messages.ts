import type { Command } from 'commander';
import { withApp, printTable } from './util.js';
import { rowToCompact } from '../../core/normalize.js';

export function register(program: Command): void {
  program
    .command('messages <room>')
    .description('Show messages for a room')
    .option('-n, --count <n>', 'number of messages to show', '30')
    .option('--before <ISO>', 'show messages before this ISO timestamp')
    .option('--include-system', 'include system messages')
    .option('--json', 'output as compact JSON records')
    .action(
      async (
        room: string,
        opts: { count: string; before?: string; includeSystem?: boolean; json?: boolean },
      ) => {
        await withApp(async (app) => {
          const count = Math.max(1, parseInt(opts.count, 10) || 30);
          const roomRow = await app.rooms.resolve(room);

          await app.sync.ensureRoomSynced(roomRow.rid);

          // Extend backfill if the requested `before` point is older than what
          // we have loaded (mirror of the logic in sync.ts / MCP get_messages).
          if (opts.before) {
            const oldest = roomRow.oldest_loaded_ts;
            const notFullyBackfilled = roomRow.fully_backfilled !== 1;
            if (notFullyBackfilled && oldest != null && opts.before <= oldest) {
              await app.sync.extendBackfill(roomRow.rid, opts.before);
            }
          }

          const rows = app.db.getTimeline(roomRow.rid, {
            limit: count,
            beforeTs: opts.before,
            includeSystem: opts.includeSystem,
          });

          // getTimeline returns DESC (newest first); reverse for human display.
          const ordered = [...rows].reverse();

          if (opts.json) {
            const compact = ordered.map((r) => rowToCompact(r));
            process.stdout.write(JSON.stringify(compact) + '\n');
            return;
          }

          if (ordered.length === 0) {
            process.stdout.write('No messages found.\n');
            return;
          }

          const tableRows: string[][] = [];
          for (const r of ordered) {
            const time = r.ts ? new Date(r.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '??:??';
            const author = r.author_username ?? r.author_name ?? r.author_id ?? '?';
            let text = r.text;
            if (r.tcount && r.tcount > 0) {
              text += `  (${r.tcount} ${r.tcount === 1 ? 'reply' : 'replies'}, id: ${r.id})`;
            }
            tableRows.push([`[${time}]`, `@${author}:`, text]);
          }
          printTable(tableRows);
        });
      },
    );
}
