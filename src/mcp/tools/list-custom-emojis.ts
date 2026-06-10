import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { fail, ok } from './shared.js';

export function registerListCustomEmojisTool(server: McpServer, app: App): void {
  server.registerTool(
    'list_custom_emojis',
    {
      description:
        'List custom emojis registered on this Rocket.Chat server ' +
        '(server-specific, beyond standard unicode emoji). Use these names ' +
        'with add_reaction or as :name: in send_message text.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Case-insensitive substring to match an emoji name.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ filter }) => {
      try {
        // list() calls ensureFresh() internally (TTL-guarded), so this is one
        // refresh on a cold/stale cache and zero network calls when fresh.
        const emojis = await app.emojis.list(filter);
        return ok({
          emojis: emojis.map((e) => ({ name: e.name, aliases: e.aliases })),
          count: emojis.length,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
