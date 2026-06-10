import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { withApp, printTable } from './util.js';

export function register(program: Command): void {
  program
    .command('emojis')
    .description('List custom emojis from the local cache')
    .option('--filter <substr>', 'filter by name substring')
    .option('--sync', 'force a refresh, ignoring the cache TTL')
    .option('--export <dir>', 'write each cached emoji image as <name>.<ext> to a directory')
    .option('--json', 'output as JSON array')
    .action(
      async (
        opts: { filter?: string; sync?: boolean; export?: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          // --sync forces a refresh even if the cache is fresh.
          if (opts.sync) await app.emojis.refresh();

          const emojis = await app.emojis.list(opts.filter);

          // --export: fill any missing images (concurrency 2, stderr progress)
          // and write them out. Export is the one place where waiting on image
          // downloads is expected.
          if (opts.export !== undefined) {
            const dir = opts.export;
            await mkdir(dir, { recursive: true });
            process.stderr.write('Fetching emoji images…\n');
            await app.emojis.fillImages((done, total) => {
              process.stderr.write(`\r  ${done}/${total}`);
              if (done === total) process.stderr.write('\n');
            });

            let written = 0;
            for (const e of emojis) {
              if (!e.extension) continue;
              const image = await app.emojis.getImage(e.name);
              if (!image) continue;
              const file = join(dir, `${e.name}.${e.extension}`);
              await writeFile(file, image.bytes);
              written++;
            }
            process.stdout.write(`Exported ${written} emoji image(s) to ${dir}\n`);
            return;
          }

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(JSON.stringify(emojis) + '\n');
            return;
          }

          if (emojis.length === 0) {
            process.stdout.write('No custom emojis found.\n');
            return;
          }

          const header = ['NAME', 'ALIASES'];
          const body = emojis.map((e) => [e.name, e.aliases.join(', ')]);
          printTable([header, ...body]);
        });
      },
    );
}
