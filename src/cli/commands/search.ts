import type { Command } from 'commander';
import { withApp, printTable } from './util.js';

export function register(program: Command): void {
  program
    .command('search <query>')
    .description('Search messages (local FTS5 with optional server fallback)')
    .option('--room <r>', 'limit search to a specific room')
    .option('--author <u>', 'filter by author username')
    .option('--limit <n>', 'maximum results', '20')
    .option('--json', 'output raw SearchResult as JSON')
    .action(
      async (
        query: string,
        opts: { room?: string; author?: string; limit: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const limit = Math.max(1, parseInt(opts.limit, 10) || 20);

          let roomRow: Awaited<ReturnType<typeof app.rooms.resolve>> | undefined;
          if (opts.room) {
            roomRow = await app.rooms.resolve(opts.room);
          }

          const result = await app.search.search(query, {
            room: roomRow,
            author: opts.author,
            limit,
          });

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(JSON.stringify(result) + '\n');
            return;
          }

          if (result.results.length === 0) {
            process.stdout.write('No results found.\n');
            if (result.note) process.stdout.write(`Note: ${result.note}\n`);
            return;
          }

          const tableRows: string[][] = [];
          for (const hit of result.results) {
            const roomLabel = `#${hit.roomId}`;
            const timeLabel = hit.time ? `[${new Date(hit.time).toLocaleString()}]` : '';
            const authorLabel = `@${hit.author}`;
            const text = hit.snippet ?? hit.text;
            const source = `(${hit.source})`;
            tableRows.push([roomLabel, authorLabel, timeLabel, text, source]);
          }
          printTable(tableRows);

          if (result.note) {
            process.stdout.write(`\nNote: ${result.note}\n`);
          }
        });
      },
    );
}
