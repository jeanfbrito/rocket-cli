import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { RcApiError } from '../../core/errors.js';
import { fail, ok } from './shared.js';

/** Wrap an emoji name in colons if not already wrapped. */
function normalizeEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return trimmed;
  return `:${trimmed.replace(/^:+|:+$/g, '')}:`;
}

export function registerAddReactionTool(server: McpServer, app: App): void {
  server.registerTool(
    'add_reaction',
    {
      description:
        'React to a Rocket.Chat message with an emoji. Use this to ' +
        'acknowledge a message — messageId comes from get_messages or ' +
        'get_thread_messages results. The emoji name can be given with or ' +
        'without surrounding colons (e.g. "thumbsup" or ":thumbsup:"). ' +
        'Set remove: true to withdraw an existing reaction.',
      inputSchema: {
        messageId: z.string().describe('id of the message to react to'),
        emoji: z
          .string()
          .describe("emoji name, e.g. 'thumbsup' or ':thumbsup:'"),
        remove: z
          .boolean()
          .default(false)
          .describe('remove the reaction instead of adding it'),
      },
    },
    async ({ messageId, emoji, remove }) => {
      try {
        const normalizedEmoji = normalizeEmoji(emoji);
        await app.rc.react({
          messageId,
          emoji: normalizedEmoji,
          shouldReact: !remove,
        });
        return ok({ reacted: !remove, messageId, emoji: normalizedEmoji });
      } catch (err) {
        // Enrich invalid-emoji failures with custom-emoji suggestions. The
        // server rejects an unknown emoji with an 'Invalid emoji' message or an
        // 'error-not-allowed' errorType. Suggestion lookup must NEVER mask the
        // original error, so it's wrapped in its own try/catch.
        const original = err instanceof Error ? err.message : String(err);
        const errorType =
          err instanceof RcApiError ? err.errorType : undefined;
        const isInvalidEmoji =
          /invalid emoji/i.test(original) || errorType === 'error-not-allowed';

        if (isInvalidEmoji) {
          let suggestionNote = '';
          try {
            const suggestions = app.emojis.suggest(emoji);
            if (suggestions.length > 0) {
              suggestionNote = ` Registered custom emojis with similar names: ${suggestions.join(', ')}.`;
            }
          } catch {
            // Suggestion failure must not mask the original error.
          }
          return fail(
            new Error(
              `${original}${suggestionNote} Use list_custom_emojis to see all custom emojis.`,
            ),
          );
        }
        return fail(err);
      }
    },
  );
}
