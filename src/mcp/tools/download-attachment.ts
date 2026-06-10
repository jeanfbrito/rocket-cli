import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { downloadFile } from '../../core/files.js';
import { fail, ok } from './shared.js';

export function registerDownloadAttachmentTool(server: McpServer, app: App): void {
  server.registerTool(
    'download_attachment',
    {
      description:
        "Download a message attachment to local disk. The fileUrl comes from a " +
        "message's attachments in get_messages output: an attachment line looks " +
        "like '[image] pic.png -> /file-upload/abc/pic.png' — pass the part " +
        "after '->'. Optionally provide savePath; otherwise the file lands in " +
        '~/Downloads. This tool writes to the local filesystem (not the server).',
      inputSchema: {
        fileUrl: z
          .string()
          .describe(
            "Attachment link from a message's attachments (the part after '->'). " +
              'A /file-upload/... path or an absolute URL on the same server.',
          ),
        savePath: z
          .string()
          .optional()
          .describe('Absolute path to write to (optional; defaults to ~/Downloads/<name>).'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ fileUrl, savePath }) => {
      try {
        const result = await downloadFile(app.config, { fileUrl, savePath });
        return ok({
          savedTo: result.path,
          bytes: result.bytes,
          contentType: result.contentType,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
