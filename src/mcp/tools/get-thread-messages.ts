import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { rowToCompact, rowToCompactWithLink } from '../../core/normalize.js';
import { extractMessageId, looksLikeUrl } from '../../core/urls.js';
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
          .describe(
            'Thread parent message id OR a pasted Rocket.Chat message link ' +
              '(the message id / thread tmid is extracted from the URL).',
          ),
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
        // Accept a pasted message link in place of a raw id.
        const tmid = looksLikeUrl(threadId)
          ? (extractMessageId(app.config.url, threadId) ?? threadId)
          : threadId;
        const parent = await app.sync.ensureThreadLoaded(tmid);
        const replies = app.db.getThreadMessages(tmid, { limit: count });
        const room = app.db.getRoom(parent.rid);
        // Links require the room row; when the room isn't cached, omit them.
        const toCompact = room
          ? (r: typeof parent) => rowToCompactWithLink(r, room, app.config.url)
          : rowToCompact;
        return ok({
          parent: toCompact(parent),
          messages: replies.map(toCompact),
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
