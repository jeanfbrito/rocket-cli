import type { Command } from 'commander';
import { withApp } from './util.js';
import { messageToRow, rowToCompact, rowToCompactWithLink } from '../../core/normalize.js';
import type { MessageRow } from '../../core/types.js';

/**
 * `context <messageId>` — show the conversation around a single message.
 *
 * Mirrors the get_message_context MCP tool's pivot logic so the CLI and the
 * tool agree: thread replies pivot to their thread, thread parents show their
 * first replies, everything else shows the surrounding main timeline. `--json`
 * emits the same payload the tool returns.
 */
export function register(program: Command): void {
  program
    .command('context <messageId>')
    .description('Show the conversation around a specific message id')
    .option('--before <n>', 'messages to show before the target', '10')
    .option('--after <n>', 'messages to show after the target', '5')
    .option('--json', 'output as the get_message_context tool payload')
    .action(
      async (
        messageId: string,
        opts: { before: string; after: string; json?: boolean },
        command: Command,
      ) => {
        await withApp(async (app) => {
          const before = clamp(parseInt(opts.before, 10), 10);
          const after = clamp(parseInt(opts.after, 10), 5);

          let target = app.db.getMessage(messageId);
          if (!target) {
            const res = await app.rc.getMessage({ msgId: messageId });
            if (res.message && res.message._id) {
              const rid = res.message.rid ?? '';
              app.db.upsertMessages([messageToRow(res.message, rid)]);
              target = app.db.getMessage(messageId);
            }
          }
          if (!target) {
            process.stderr.write(`Message "${messageId}" not found.\n`);
            process.exitCode = 1;
            return;
          }

          await app.sync.ensureRoomSynced(target.rid);
          target = app.db.getMessage(messageId) ?? target;

          let mode: 'timeline' | 'thread';
          let ordered: MessageRow[];

          if (target.tmid) {
            mode = 'thread';
            await app.sync.ensureThreadLoaded(target.tmid);
            const replies = app.db.getThreadMessages(target.tmid);
            ordered = sliceAround(replies, target.id, before, after);
          } else if (typeof target.tcount === 'number' && target.tcount > 0) {
            mode = 'thread';
            await app.sync.ensureThreadLoaded(target.id);
            const replies = app.db.getThreadMessages(target.id, {
              limit: before + after,
            });
            ordered = [target, ...replies];
          } else {
            mode = 'timeline';
            // getTimeline orders DESC. `ts < target.ts` LIMIT N yields the N
            // closest-older rows (reverse to ascending). `ts > target.ts` LIMIT
            // N would yield the NEWEST N (a gap), so over-fetch and take the
            // closest N ascending for the after-slice.
            const beforeRows = before > 0
              ? [...app.db.getTimeline(target.rid, { limit: before, beforeTs: target.ts })].reverse()
              : [];
            let afterRows: MessageRow[] = [];
            if (after > 0) {
              afterRows = app.db.getTimeline(target.rid, { limit: 500, afterTs: target.ts });
              afterRows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
              afterRows = afterRows.slice(0, after);
            }
            ordered = [...beforeRows, target, ...afterRows];
          }

          const room = app.db.getRoom(target.rid);
          const toCompact = (r: MessageRow) =>
            room ? rowToCompactWithLink(r, room, app.config.url) : rowToCompact(r);

          if (command.optsWithGlobals<{ json?: boolean }>().json) {
            process.stdout.write(
              JSON.stringify({
                mode,
                room: room
                  ? {
                      id: room.rid,
                      name: room.name ?? room.fname ?? room.rid,
                      type:
                        room.t === 'p' ? 'group' : room.t === 'd' ? 'dm' : 'channel',
                    }
                  : { id: target.rid },
                target: toCompact(target),
                messages: ordered.map(toCompact),
              }) + '\n',
            );
            return;
          }

          for (const r of ordered) {
            const time = r.ts
              ? new Date(r.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
              : '??:??';
            const author = r.author_username ?? r.author_name ?? r.author_id ?? '?';
            const marker = r.id === target.id ? '→ ' : '  ';
            process.stdout.write(`${marker}[${time}] @${author}: ${r.text ?? ''}\n`);
          }
        });
      },
    );
}

/** Parse an int option, clamping to [0, 50] with a default on NaN. */
function clamp(n: number, fallback: number): number {
  if (Number.isNaN(n)) return fallback;
  return Math.max(0, Math.min(50, n));
}

/** Slice an ASC list around the target id, keeping `before`/`after` neighbors. */
function sliceAround(
  rows: MessageRow[],
  targetId: string,
  before: number,
  after: number,
): MessageRow[] {
  const idx = rows.findIndex((r) => r.id === targetId);
  if (idx === -1) return rows.slice(0, before + after + 1);
  const start = Math.max(0, idx - before);
  const end = Math.min(rows.length, idx + after + 1);
  return rows.slice(start, end);
}
