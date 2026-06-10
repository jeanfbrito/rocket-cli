import type { Command } from 'commander';
import { withApp } from './util.js';
import { uploadFile } from '../../core/files.js';
import { messageToRow, rowToCompact } from '../../core/normalize.js';

export function register(program: Command): void {
  program
    .command('upload <room> <file>')
    .description('Upload a local file to a room or thread')
    .option('--text <t>', 'caption message for the attachment')
    .option('--thread <id>', 'attach inside the thread with this parent message id')
    .option('--name <n>', 'override the uploaded file name')
    .option('--json', 'output the created message as JSON')
    .action(
      async (
        room: string,
        file: string,
        opts: { text?: string; thread?: string; name?: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const roomRow = await app.rooms.resolve(room);
          const { message } = await uploadFile(app.config, {
            rid: roomRow.rid,
            filePath: file,
            text: opts.text,
            threadId: opts.thread,
            fileName: opts.name,
          });

          // Write-through into the cache so the next read sees it.
          const row = messageToRow(message, roomRow.rid);
          app.db.upsertMessages([row]);
          const compact = rowToCompact(row);

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(JSON.stringify(compact) + '\n');
            return;
          }

          const roomLabel = roomRow.name ?? roomRow.fname ?? roomRow.rid;
          process.stdout.write(`Uploaded ${file} (msg id: ${compact.id}) to ${roomLabel}\n`);
        });
      },
    );
}
