import type { Command } from 'commander';
import { WatchService, MIN_INTERVAL_SECONDS, type WatchMatch } from '../../core/watch.js';
import { withApp } from './util.js';

/** Format a match for human stdout: `[HH:MM] #room @author: text`. */
function formatMatch(m: WatchMatch): string {
  const d = new Date(m.time);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `[${hh}:${mm}] #${m.roomName} @${m.author}: ${m.text}`;
}

export function register(program: Command): void {
  program
    .command('watch <query>')
    .description('Monitor rooms for messages matching a query (local FTS).')
    .option('--room <r>', 'limit to a specific room (default: all rooms)')
    .option('--interval <sec>', 'poll interval in seconds', '60')
    .option('--once', 'run a single pass over the last 24h and exit')
    .option('--notify <target>', 'post each match to this room/user')
    .option('--log <path>', 'append matches as JSON lines to this file')
    .option('--json', 'emit matches as JSON lines')
    .action(
      async (
        query: string,
        opts: {
          room?: string;
          interval: string;
          once?: boolean;
          notify?: string;
          log?: string;
          json?: boolean;
        },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const json = command.optsWithGlobals<{ json?: boolean }>().json === true;
          const watch = new WatchService(app);

          // ---- one-shot mode --------------------------------------------------
          if (opts.once) {
            const sinceTs = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
            const res = await watch.runOnce({
              query,
              room: opts.room,
              sinceTs,
            });

            if (json) {
              for (const m of res.matches) {
                process.stdout.write(JSON.stringify(m) + '\n');
              }
            } else if (res.matches.length === 0) {
              process.stdout.write('No matches.\n');
            } else {
              for (const m of res.matches) {
                process.stdout.write(formatMatch(m) + '\n');
              }
            }
            return;
          }

          // ---- loop mode ------------------------------------------------------
          let intervalSeconds = parseInt(opts.interval, 10);
          if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
            intervalSeconds = 60;
          }
          if (intervalSeconds < MIN_INTERVAL_SECONDS) {
            process.stderr.write(
              `Interval ${intervalSeconds}s is below the ${MIN_INTERVAL_SECONDS}s ` +
                `floor; using ${MIN_INTERVAL_SECONDS}s.\n`,
            );
            intervalSeconds = MIN_INTERVAL_SECONDS;
          }

          const controller = new AbortController();
          let count = 0;
          const onSigint = (): void => controller.abort();
          process.once('SIGINT', onSigint);

          process.stderr.write(
            `Watching ${opts.room ? `#${opts.room}` : 'all rooms'} for ` +
              `"${query}" every ${intervalSeconds}s. Ctrl-C to stop.\n`,
          );

          try {
            await watch.watch({
              query,
              room: opts.room,
              intervalSeconds,
              notifyTarget: opts.notify,
              logPath: opts.log,
              signal: controller.signal,
              onMatch: (m) => {
                count++;
                if (json) {
                  process.stdout.write(JSON.stringify(m) + '\n');
                } else {
                  process.stdout.write(formatMatch(m) + '\n');
                }
              },
            });
          } finally {
            process.removeListener('SIGINT', onSigint);
          }

          process.stderr.write(`Stopped. ${count} match(es) delivered.\n`);
        });
      },
    );
}
