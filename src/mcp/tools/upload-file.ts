import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { uploadFile } from '../../core/files.js';
import { messageToRow, rowToCompact } from '../../core/normalize.js';
import { fail, ok } from './shared.js';

export function registerUploadFileTool(server: McpServer, app: App): void {
  server.registerTool(
    'upload_file',
    {
      description:
        'Attach a local file to a Rocket.Chat room or thread. Provide the ' +
        'absolute path to a file on this machine and optionally a caption ' +
        '(text). Pass threadId to attach inside a thread. The created message ' +
        'is written into the local cache so it appears in the next ' +
        'get_messages without a sync. This tool writes — it uploads to the ' +
        'server and posts a message.',
      inputSchema: {
        room: z
          .string()
          .describe('Where to upload: #channel, @username, a room name, or a room id.'),
        filePath: z.string().describe('Absolute path to a local file.'),
        text: z.string().optional().describe('Optional caption message for the attachment.'),
        threadId: z
          .string()
          .optional()
          .describe('Id of a thread parent message to attach within (optional).'),
        fileName: z
          .string()
          .optional()
          .describe('Override the uploaded file name (optional; defaults to the basename).'),
      },
    },
    async ({ room, filePath, text, threadId, fileName }) => {
      try {
        const roomRow = await app.rooms.resolve(room);
        const { message } = await uploadFile(app.config, {
          rid: roomRow.rid,
          filePath,
          text,
          threadId,
          fileName,
        });
        // Write-through into the cache, mirroring app.sendMessage.
        const row = messageToRow(message, roomRow.rid);
        app.db.upsertMessages([row]);
        return ok({ sent: rowToCompact(row) });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
