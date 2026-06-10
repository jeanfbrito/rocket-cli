import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { collectMentions } from '../../core/mentions.js';
import { fail, ok } from './shared.js';

export function registerGetMentionsTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_mentions',
    {
      description:
        'Messages that mention the user (@username) across all cached rooms — ' +
        "the 'what needs my attention' triage feed. Each message carries a " +
        'clickable link. Set includeChannelWide=true to also include @all/@here.',
      inputSchema: {
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe('How far back to look, in days (1-90, default 7).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe('Max total mentioning messages to return (1-100, default 50).'),
        includeChannelWide: z
          .boolean()
          .default(false)
          .describe('Also include channel-wide @all/@here mentions (default false).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceDays, limit, includeChannelWide }) => {
      try {
        const report = await collectMentions(app, {
          sinceDays,
          limit,
          includeChannelWide,
        });
        return ok(report);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
