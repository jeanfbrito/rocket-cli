import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sendMessage, type App } from '../../core/app.js';
import { fail, ok } from './shared.js';

export function registerSendMessageTool(server: McpServer, app: App): void {
  server.registerTool(
    'send_message',
    {
      description:
        'Send a message to a Rocket.Chat room or as a thread reply. The ' +
        'target may be #channel, @username (DM), a room name, or a room id. ' +
        'Pass threadId (the id of a thread parent message) to reply inside ' +
        'that thread. The sent message is written into the local cache so it ' +
        'appears in the next get_messages without a sync. This tool writes — ' +
        'it posts to the server.',
      inputSchema: {
        target: z
          .string()
          .describe('Where to send: #channel, @username, a room name, or a room id.'),
        text: z
          .string()
          .min(1)
          .describe('The message body. Must not be empty.'),
        threadId: z
          .string()
          .optional()
          .describe('Id of a thread parent message to reply within (optional).'),
      },
    },
    async ({ target, text, threadId }) => {
      try {
        const sent = await sendMessage(app, { target, text, threadId });
        return ok({ sent });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
