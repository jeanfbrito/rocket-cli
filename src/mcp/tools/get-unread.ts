import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { collectUnread } from '../../core/unread.js';
import { fail, ok } from './shared.js';

export function registerGetUnreadTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_unread',
    {
      description:
        'List all messages left unread since the user last read each room in ' +
        'the Rocket.Chat UI — exact, based on the server’s per-room ' +
        'last-read watermark. Includes unread thread replies. Never marks ' +
        'anything as read. Ideal input for a catch-up summary.',
      inputSchema: {
        limitPerRoom: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe('Max unread messages to return per room (1-100, default 50).'),
        includeThreads: z
          .boolean()
          .default(true)
          .describe('Include unread thread replies (default true).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limitPerRoom, includeThreads }) => {
      try {
        const report = await collectUnread(app, { limitPerRoom, includeThreads });
        return ok(report);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
