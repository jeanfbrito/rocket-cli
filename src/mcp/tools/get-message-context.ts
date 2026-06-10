import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import type { MessageRow } from '../../core/types.js';
import { messageToRow, rowToCompact, rowToCompactWithLink } from '../../core/normalize.js';
import { fail, ok, roomTypeLabel } from './shared.js';

/**
 * Resolve the target message: local cache first, then a direct server fetch
 * (chat.getMessage) when missing, upserting the result so subsequent reads see
 * it. Returns undefined when the message cannot be found anywhere.
 */
async function resolveTarget(
  app: App,
  messageId: string,
): Promise<MessageRow | undefined> {
  let target = app.db.getMessage(messageId);
  if (target) return target;

  const res = await app.rc.getMessage({ msgId: messageId });
  if (!res.message || !res.message._id) return undefined;
  const rid = res.message.rid ?? '';
  app.db.upsertMessages([messageToRow(res.message, rid)]);
  target = app.db.getMessage(messageId);
  return target;
}

/**
 * Show the conversation around a single message.
 *
 * Pivot logic:
 *  - target.tmid set (a thread reply)  -> mode 'thread': the whole thread,
 *    sliced around the target by position (up to `before` replies before it
 *    and `after` after it; all replies when the thread is small).
 *  - target.tcount > 0 (a thread parent) -> mode 'thread': the parent plus its
 *    first `before + after` replies (replyCount is carried on the parent record).
 *  - otherwise -> mode 'timeline': the surrounding main-channel timeline,
 *    `before` messages before the target and `after` after it, target in place.
 */
export function registerGetMessageContextTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_message_context',
    {
      description:
        'Show the conversation around a specific message id (found in search ' +
        'results, mentions, or pasted links). Thread replies pivot to their ' +
        'whole thread. Every message carries a clickable link.',
      inputSchema: {
        messageId: z
          .string()
          .describe('The id of the message to center the context on.'),
        before: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(10)
          .describe('Messages to include before the target (0-50, default 10).'),
        after: z
          .number()
          .int()
          .min(0)
          .max(50)
          .default(5)
          .describe('Messages to include after the target (0-50, default 5).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ messageId, before, after }) => {
      try {
        let target = await resolveTarget(app, messageId);
        if (!target) return fail(new Error(`Message "${messageId}" not found.`));

        // Bring the room up to date (freshness), then re-read the target since a
        // delta may have edited it.
        await app.sync.ensureRoomSynced(target.rid);
        target = app.db.getMessage(messageId) ?? target;

        let mode: 'timeline' | 'thread';
        let ordered: MessageRow[];

        if (target.tmid) {
          // Thread reply: pivot to the whole thread, sliced around the target.
          mode = 'thread';
          await app.sync.ensureThreadLoaded(target.tmid);
          const replies = app.db.getThreadMessages(target.tmid); // all, ASC
          ordered = sliceAround(replies, target.id, before, after);
        } else if (typeof target.tcount === 'number' && target.tcount > 0) {
          // Thread parent: parent + its first (before + after) replies.
          mode = 'thread';
          await app.sync.ensureThreadLoaded(target.id);
          const replies = app.db.getThreadMessages(target.id, {
            limit: before + after,
          });
          ordered = [target, ...replies];
        } else {
          // Plain message: surrounding main timeline.
          mode = 'timeline';
          ordered = [...timelineBefore(app, target, before), target, ...timelineAfter(app, target, after)];
        }

        const room = app.db.getRoom(target.rid);
        const toCompact = (r: MessageRow) =>
          room ? rowToCompactWithLink(r, room, app.config.url) : rowToCompact(r);

        return ok({
          mode,
          room: room
            ? {
                id: room.rid,
                name: room.name ?? room.fname ?? room.rid,
                type: roomTypeLabel(room.t),
              }
            : { id: target.rid },
          target: toCompact(target),
          messages: ordered.map(toCompact),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/**
 * The `before` messages immediately preceding `target` in the main timeline,
 * chronological. getTimeline orders DESC + LIMIT, so `ts < target.ts` LIMIT N
 * naturally yields the N closest-older rows; reverse them to ascending.
 */
function timelineBefore(app: App, target: MessageRow, before: number): MessageRow[] {
  if (before <= 0) return [];
  return [...app.db.getTimeline(target.rid, { limit: before, beforeTs: target.ts })].reverse();
}

/**
 * The `after` messages immediately following `target` in the main timeline,
 * chronological. getTimeline orders DESC, so `ts > target.ts` LIMIT N returns
 * the NEWEST N after the target — a gap, not the neighbors. Over-fetch the rows
 * after the target (no explicit ASC query is available on Db without widening
 * its API, which this builder does not own), sort ascending, and take the
 * closest N.
 */
function timelineAfter(app: App, target: MessageRow, after: number): MessageRow[] {
  if (after <= 0) return [];
  const rows = app.db.getTimeline(target.rid, { limit: AFTER_FETCH_CAP, afterTs: target.ts });
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return rows.slice(0, after);
}

/** Upper bound on rows pulled when computing the after-slice. The room's loaded
 *  window is itself bounded (backfillLimit), so this only caps pathological
 *  rooms; the closest `after` neighbors always fall within it. */
const AFTER_FETCH_CAP = 500;

/**
 * Slice an ASC-ordered list around the row whose id is `targetId`, keeping up
 * to `before` rows before it and `after` rows after it, with the target in
 * place. When the target is absent (defensive), returns the head of the list
 * bounded by before+after+1.
 */
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
