import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { fail, ok, readEnvelope } from './shared.js';

export function registerGetMessagesTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_messages',
    {
      description:
        'Read recent messages from a Rocket.Chat room (channel, private ' +
        'group, or DM), newest first. Messages with a replyCount are thread ' +
        'parents — pass their id as threadId to get_thread_messages to read ' +
        'the full thread. Thread replies are not shown inline here. Use ' +
        'list_rooms first to find the room. Use before/after (ISO 8601 ' +
        'timestamps) to page through history; reading older than the cached ' +
        'window transparently fetches more from the server.',
      inputSchema: {
        room: z
          .string()
          .describe('Room reference: id, #channel, @username, name, or display name.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(30)
          .describe('How many messages to return (1-100, default 30).'),
        before: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp; return only messages older than this.'),
        after: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp; return only messages newer than this.'),
        includeSystem: z
          .boolean()
          .default(false)
          .describe('Include system messages (joins, topic changes, etc.).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ room, count, before, after, includeSystem }) => {
      try {
        const roomRow = await app.rooms.resolve(room);
        const rid = roomRow.rid;
        await app.sync.ensureRoomSynced(rid);

        // If the requested window starts at/below our backfill horizon, pull
        // older history first so the read is complete.
        const refreshed = app.db.getRoom(rid) ?? roomRow;
        if (
          before !== undefined &&
          refreshed.fully_backfilled !== 1 &&
          refreshed.oldest_loaded_ts != null &&
          before <= refreshed.oldest_loaded_ts
        ) {
          await app.sync.extendBackfill(rid, before);
        }

        const rows = app.db.getTimeline(rid, {
          limit: count,
          beforeTs: before,
          afterTs: after,
          includeSystem,
        });
        const finalRoom = app.db.getRoom(rid) ?? refreshed;
        return ok(readEnvelope(finalRoom, rows, app.config.url));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
