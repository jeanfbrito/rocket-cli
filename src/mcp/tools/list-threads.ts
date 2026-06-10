import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { fail, ok, readEnvelope } from './shared.js';

export function registerListThreadsTool(server: McpServer, app: App): void {
  server.registerTool(
    'list_threads',
    {
      description:
        'List the active threads in a Rocket.Chat room, most recently ' +
        'active first. Each item is a thread parent message carrying a ' +
        'replyCount and lastReplyAt — pass its id as threadId to ' +
        'get_thread_messages to read the conversation. Use list_rooms first ' +
        'to find the room. Optionally filter parents by text.',
      inputSchema: {
        room: z
          .string()
          .describe('Room reference: id, #channel, @username, name, or display name.'),
        count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(25)
          .describe('Maximum number of threads to return (1-100, default 25).'),
        text: z
          .string()
          .optional()
          .describe('Case-insensitive substring to match the thread parent text.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ room, count, text }) => {
      try {
        const roomRow = await app.rooms.resolve(room);
        const rid = roomRow.rid;
        // Read path: serve from cache, revalidate in background.
        const outcome = await app.sync.ensureRoomSyncedSWR(rid);
        await app.sync.seedThreadParents(rid);

        const parents = app.db.getThreadParents(rid, { limit: count, textLike: text });
        const finalRoom = app.db.getRoom(rid) ?? roomRow;
        return ok(
          readEnvelope(finalRoom, parents, app.config.url, outcome.refreshing),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
