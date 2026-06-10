import type { Command } from 'commander';
import { withApp } from './util.js';
import { downloadFile } from '../../core/files.js';

export function register(program: Command): void {
  program
    .command('download <fileUrl>')
    .description('Download a message attachment to local disk')
    .option('--out <path>', 'where to save the file (default: ~/Downloads/<name>)')
    .option('--json', 'output the result as JSON')
    .action(
      async (
        fileUrl: string,
        opts: { out?: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const result = await downloadFile(app.config, {
            fileUrl,
            savePath: opts.out,
          });

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(
              JSON.stringify({
                savedTo: result.path,
                bytes: result.bytes,
                contentType: result.contentType,
              }) + '\n',
            );
            return;
          }

          process.stdout.write(`Downloaded ${result.bytes} bytes to ${result.path}\n`);
        });
      },
    );
}
