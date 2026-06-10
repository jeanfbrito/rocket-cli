import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { coverageOf, fail, ok } from './shared.js';

export function registerSyncHistoryTool(server: McpServer, app: App): void {
  server.registerTool(
    'sync_history',
    {
      description:
        'Load older message history for a room into the local cache. Use ' +
        'ONLY when a task needs history beyond what get_messages returns ' +
        '(get_messages auto-loads recent history). Example: "summarize the ' +
        'last month in #general" → call sync_history first, then read. ' +
        'Routine triage (get_unread / get_attention) never needs this — those ' +
        'fetch exactly the unread slice. Deepens ONE room per call. Omit ' +
        '`room` to deepen the most stale unread room. Server-read-only: writes ' +
        'only to the local cache, never marks anything read.',
      inputSchema: {
        room: z
          .string()
          .optional()
          .describe(
            'Room reference (id, #channel, @username, name, or display ' +
              'name). Omit to deepen the most stale unread room.',
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            'Max additional older messages to load this call (default: the ' +
              "server's configured backfill limit).",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ room, depth }) => {
      try {
        let rid: string;
        if (room !== undefined) {
          rid = (await app.rooms.resolve(room)).rid;
        } else {
          const picked = app.sync.pickStaleUnreadRoom();
          if (picked == null) {
            return ok({
              room: null,
              messagesLoaded: 0,
              coverage: 'full',
              note: 'No unread room needs deepening — everything is either fully backfilled or read.',
            });
          }
          rid = picked;
        }

        const result = await app.sync.deepenRoom(rid, depth);
        const roomRow = app.db.getRoom(rid);
        return ok({
          room: {
            id: rid,
            name: roomRow?.name ?? roomRow?.fname ?? rid,
          },
          messagesLoaded: result.messagesLoaded,
          coverage: roomRow ? coverageOf(roomRow) : 'partial',
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
