import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { fail, ok, roomTypeCode, roomTypeLabel } from './shared.js';

export function registerListRoomsTool(server: McpServer, app: App): void {
  server.registerTool(
    'list_rooms',
    {
      description:
        'List Rocket.Chat rooms you belong to: public channels, private ' +
        'groups, and direct messages. Use this first to discover rooms and ' +
        'their ids/names before calling get_messages, list_threads, or ' +
        'search_messages. Filter by name substring or room type.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive substring to match room name or display name.'),
        type: z
          .enum(['channel', 'group', 'dm'])
          .optional()
          .describe('Restrict to one room type.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe('Maximum number of rooms to return (1-200, default 50).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filter, type, limit }) => {
      try {
        const t = type !== undefined ? roomTypeCode(type) : undefined;
        const rooms = await app.rooms.list({ nameLike: filter, type: t });
        const sliced = rooms.slice(0, limit);
        const payload = {
          rooms: sliced.map((r) => ({
            id: r.rid,
            name: r.name ?? r.fname ?? r.rid,
            displayName: r.fname ?? r.name ?? r.rid,
            type: roomTypeLabel(r.t),
            unread: r.unread,
            syncedThrough: r.last_synced_at ?? null,
          })),
          returned: sliced.length,
        };
        return ok(payload);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
