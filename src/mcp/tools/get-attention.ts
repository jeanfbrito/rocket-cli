import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { collectAttention } from '../../core/attention.js';
import { fail, ok } from './shared.js';

export function registerGetAttentionTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_attention',
    {
      description:
        'One-call triage: everything that needs the user\'s attention — ' +
        'mentions of them, unread DMs, unread thread replies, and unread ' +
        'channel messages, prioritized and deduplicated, every item with a ' +
        'clickable link. Never marks anything as read. Use this first when the ' +
        "user asks 'what did I miss?' or 'what needs my attention?'.",
      inputSchema: {
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(90)
          .default(7)
          .describe('How far back the mentions search looks, in days (1-90, default 7).'),
        limitPerSection: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(30)
          .describe('Max items to surface per section (1-100, default 30).'),
        includeChannelWide: z
          .boolean()
          .default(false)
          .describe('Also include channel-wide @all/@here mentions (default false).'),
        includeHidden: z
          .boolean()
          .default(false)
          .describe(
            'Also include unread rooms whose "Hide unread counter" setting is ' +
              'on (default false = UI parity). Mentions in hidden rooms always ' +
              'surface regardless of this flag.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sinceDays, limitPerSection, includeChannelWide, includeHidden }) => {
      try {
        const report = await collectAttention(app, {
          sinceDays,
          limitPerSection,
          includeChannelWide,
          includeHidden,
        });
        return ok(report);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
