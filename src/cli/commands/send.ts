import type { Command } from 'commander';
import { withApp } from './util.js';
import { sendMessage } from '../../core/app.js';

export function register(program: Command): void {
  program
    .command('send <target> [text...]')
    .description('Send a message to a room or user')
    .option('--thread <id>', 'reply to thread with this parent message id')
    .option('--json', 'output sent message as JSON')
    .action(
      async (
        target: string,
        textParts: string[],
        opts: { thread?: string; json?: boolean },
      ) => {
        await withApp(async (app) => {
          const text = textParts.join(' ');
          if (!text.trim()) {
            process.stderr.write('Error: message text cannot be empty.\n');
            process.exitCode = 1;
            return;
          }

          const compact = await sendMessage(app, {
            target,
            text,
            threadId: opts.thread,
          });

          if (opts.json) {
            process.stdout.write(JSON.stringify(compact) + '\n');
            return;
          }

          // Resolve room name for display (best-effort).
          let roomLabel = compact.threadId ? `(thread in room)` : '';
          try {
            const roomRow = await app.rooms.resolve(target);
            roomLabel = roomRow.name ?? roomRow.fname ?? roomRow.rid;
          } catch {
            // target may be a #channel or @user sigil; use as-is.
            roomLabel = target;
          }

          process.stdout.write(`Sent (id: ${compact.id}) to ${roomLabel}\n`);
        });
      },
    );
}
