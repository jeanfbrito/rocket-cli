import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { fail, ok } from './shared.js';

export function registerSearchMessagesTool(server: McpServer, app: App): void {
  server.registerTool(
    'search_messages',
    {
      description:
        'Full-text search Rocket.Chat messages. Searches across ALL cached ' +
        'rooms by default (the local cache is the superpower here). Each ' +
        'result carries a snippet and a source ("local" or "server"). Pass a ' +
        'room to scope the search and enable a server-side fallback that ' +
        'reaches uncached history; filter by author username. Returns ' +
        'localOnly and an optional note explaining thin or degraded results.',
      inputSchema: {
        query: z.string().describe('The text to search for.'),
        room: z
          .string()
          .optional()
          .describe('Scope to one room (id/#channel/@user/name) and enable server fallback.'),
        author: z
          .string()
          .optional()
          .describe('Restrict to messages from this author username.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('Maximum number of results (1-100, default 20).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, room, author, limit }) => {
      try {
        const roomRow = room !== undefined ? await app.rooms.resolve(room) : undefined;
        const result = await app.search.search(query, {
          room: roomRow,
          author,
          limit,
        });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
