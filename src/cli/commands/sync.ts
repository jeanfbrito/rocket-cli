import type { Command } from 'commander';
import { withApp } from './util.js';

export function register(program: Command): void {
  program
    .command('sync [room]')
    .description('Sync messages for a room or all rooms')
    .option('--all', 'sync all subscribed rooms sequentially')
    .option('--force', 'force re-sync even if cache is fresh')
    .option('--json', 'output summary as JSON')
    .action(
      async (
        room: string | undefined,
        opts: { all?: boolean; force?: boolean; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          if (!room && !opts.all) {
            process.stderr.write(
              'Error: provide a room name or pass --all to sync every room.\n',
            );
            process.exitCode = 1;
            return;
          }

          if (room) {
            const roomRow = await app.rooms.resolve(room);
            await app.sync.ensureRoomSynced(roomRow.rid, { force: opts.force });
            const count = app.db.conn
              .prepare('SELECT COUNT(*) AS n FROM messages WHERE rid = ? AND deleted = 0')
              .get(roomRow.rid) as { n: number };

            if (command.optsWithGlobals<{ json?: boolean }>().json) {
              process.stdout.write(
                JSON.stringify({ room: roomRow.name ?? roomRow.rid, messages: count.n }) + '\n',
              );
            } else {
              process.stdout.write(
                `Synced ${roomRow.name ?? roomRow.rid}: ${count.n} messages in db.\n`,
              );
            }
            return;
          }

          // --all
          const rooms = await app.rooms.list();
          let synced = 0;
          let errors = 0;
          const summaries: Array<{ room: string; messages: number; error?: string }> = [];

          for (const r of rooms) {
            const label = r.name ?? r.fname ?? r.rid;
            process.stderr.write(`Syncing ${label}...\n`);
            try {
              await app.sync.ensureRoomSynced(r.rid, { force: opts.force });
              const count = app.db.conn
                .prepare('SELECT COUNT(*) AS n FROM messages WHERE rid = ? AND deleted = 0')
                .get(r.rid) as { n: number };
              summaries.push({ room: label, messages: count.n });
              synced++;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              process.stderr.write(`  Error syncing ${label}: ${msg}\n`);
              summaries.push({ room: label, messages: 0, error: msg });
              errors++;
            }
          }

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(
              JSON.stringify({ synced, errors, rooms: summaries }) + '\n',
            );
          } else {
            process.stdout.write(
              `Done: ${synced} room(s) synced, ${errors} error(s).\n`,
            );
          }
        });
      },
    );
}
