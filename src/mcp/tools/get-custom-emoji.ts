import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { App } from '../../core/app.js';
import { fail } from './shared.js';

export function registerGetCustomEmojiTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_custom_emoji',
    {
      description: "Show a custom emoji's image. Use after list_custom_emojis.",
      inputSchema: {
        name: z.string().describe('Custom emoji name (with or without colons).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ name }): Promise<CallToolResult> => {
      const emoji = (() => {
        try {
          return app.emojis.lookup(name);
        } catch {
          return undefined;
        }
      })();

      // Image caching disabled: return text-only info (name + aliases + the
      // server image path) with a note. This is an informative result, NOT an
      // error.
      if (!app.emojis.imagesAvailable) {
        try {
          await app.emojis.list(); // ensure metadata is fresh
        } catch {
          // fall through with whatever lookup found
        }
        const found = emoji ?? app.emojis.lookup(name);
        if (!found) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `No custom emoji named "${name}" — use list_custom_emojis to see all custom emojis.`,
              },
            ],
          };
        }
        const imageUrl = found.extension
          ? app.emojis.serverImageUrl(found.name, found.extension)
          : null;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                name: found.name,
                aliases: found.aliases,
                imageUrl,
                note: 'Image caching is disabled (ROCKET_CLI_EMOJI_IMAGES=false); image not embedded.',
              }),
            },
          ],
        };
      }

      try {
        const image = await app.emojis.getImage(name);
        if (!image) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `No custom emoji named "${name}" — use list_custom_emojis to see all custom emojis.`,
              },
            ],
          };
        }
        const found = emoji ?? app.emojis.lookup(name);
        // MCP image content: { type: 'image', data: <base64>, mimeType } per the
        // SDK ImageContentSchema. A trailing text block carries the metadata.
        return {
          content: [
            {
              type: 'image',
              data: image.bytes.toString('base64'),
              mimeType: image.contentType,
            },
            {
              type: 'text',
              text: JSON.stringify({
                name: found?.name ?? name,
                aliases: found?.aliases ?? [],
              }),
            },
          ],
        };
      } catch (err) {
        // Fetch failed but the emoji metadata may still be known — degrade
        // informatively rather than surfacing a bare network error.
        const found = emoji ?? (() => {
          try {
            return app.emojis.lookup(name);
          } catch {
            return undefined;
          }
        })();
        if (found) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text:
                  `image not cached and fetch failed; emoji exists with aliases ` +
                  `[${found.aliases.join(', ')}]`,
              },
            ],
          };
        }
        return fail(err);
      }
    },
  );
}
