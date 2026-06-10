import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { rowToCompact } from '../../core/normalize.js';
import { coverageOf, fail, ok, roomTypeLabel } from './shared.js';

export function registerGetThreadMessagesTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_thread_messages',
    {
      description:
        'Read a full Rocket.Chat thread: the parent message plus all its ' +
        'replies in chronological order. Get the threadId from a message ' +
        "with a replyCount (returned by get_messages or list_threads). " +
        'Replies missing from the local cache are fetched from the server ' +
        'automatically.',
      inputSchema: {
        threadId: z
          .string()
          .describe('The id of the thread parent message.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum number of replies to return (1-200, default 50).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ threadId, count }) => {
      try {
        const parent = await app.sync.ensureThreadLoaded(threadId);
        const replies = app.db.getThreadMessages(threadId, { limit: count });
        const room = app.db.getRoom(parent.rid);
        return ok({
          parent: rowToCompact(parent),
          messages: replies.map(rowToCompact),
          room: room
            ? {
                id: room.rid,
                name: room.name ?? room.fname ?? room.rid,
                type: roomTypeLabel(room.t),
                syncedThrough: room.last_synced_at ?? null,
                coverage: coverageOf(room),
              }
            : { id: parent.rid },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
