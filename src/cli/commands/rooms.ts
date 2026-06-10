import type { Command } from 'commander';
import { withApp, printTable } from './util.js';

export function register(program: Command): void {
  program
    .command('rooms')
    .description('List rooms from the local subscription cache')
    .option('--type <type>', 'filter by room type: c, p, d, channel, group, dm')
    .option('--filter <substr>', 'filter by name substring')
    .option('--json', 'output as JSON array')
    .action(async (opts: { type?: string; filter?: string; json?: boolean }, command: Command) => {
      await withApp(async (app) => {
        // Normalize shorthand type aliases.
        let type = opts.type;
        if (type === 'channel') type = 'c';
        else if (type === 'group') type = 'p';
        else if (type === 'dm') type = 'd';

        const rooms = await app.rooms.list({
          type,
          nameLike: opts.filter,
        });

        if (command.optsWithGlobals<{ json?: boolean }>().json) {
          process.stdout.write(JSON.stringify(rooms) + '\n');
          return;
        }

        if (rooms.length === 0) {
          process.stdout.write('No rooms found.\n');
          return;
        }

        const header = ['NAME', 'TYPE', 'UNREAD', 'SYNCED THROUGH'];
        const body = rooms.map((r) => [
          r.name ?? r.fname ?? r.rid,
          r.t,
          String(r.unread),
          r.last_synced_at ?? 'never',
        ]);
        printTable([header, ...body]);
      });
    });
}
