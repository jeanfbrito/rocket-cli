// MCP server: wraps the shared core (App) behind a stdio transport and
// registers the twelve Rocket.Chat tools. stdout is reserved for the MCP
// protocol — every other byte of output goes to stderr via the core logger.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApp, type App } from '../core/app.js';
import { log } from '../core/log.js';
import { registerListRoomsTool } from './tools/list-rooms.js';
import { registerGetMessagesTool } from './tools/get-messages.js';
import { registerGetThreadMessagesTool } from './tools/get-thread-messages.js';
import { registerListThreadsTool } from './tools/list-threads.js';
import { registerSearchMessagesTool } from './tools/search-messages.js';
import { registerSendMessageTool } from './tools/send-message.js';
import { registerAddReactionTool } from './tools/add-reaction.js';
import { registerGetUserProfileTool } from './tools/get-user-profile.js';
import { registerUploadFileTool } from './tools/upload-file.js';
import { registerDownloadAttachmentTool } from './tools/download-attachment.js';
import { registerListCustomEmojisTool } from './tools/list-custom-emojis.js';
import { registerGetCustomEmojiTool } from './tools/get-custom-emoji.js';

/** Build a configured McpServer with all twelve tools registered against `app`. */
export function buildServer(app: App): McpServer {
  const server = new McpServer({ name: 'rocket-cli', version: '0.1.0' });
  registerListRoomsTool(server, app);
  registerGetMessagesTool(server, app);
  registerGetThreadMessagesTool(server, app);
  registerListThreadsTool(server, app);
  registerSearchMessagesTool(server, app);
  registerSendMessageTool(server, app);
  registerAddReactionTool(server, app);
  registerGetUserProfileTool(server, app);
  registerUploadFileTool(server, app);
  registerDownloadAttachmentTool(server, app);
  registerListCustomEmojisTool(server, app);
  registerGetCustomEmojiTool(server, app);
  return server;
}

/**
 * Entry point for `rocket-cli serve`. Creates the app (which validates config
 * and opens the DB), builds the server, and connects the stdio transport.
 * Config/setup errors are reported to stderr and exit the process BEFORE the
 * transport is connected, so a broken config never speaks half-protocol on
 * stdout.
 */
export async function runMcpServer(): Promise<void> {
  let app: App;
  try {
    app = createApp();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to start MCP server: ${msg}`);
    process.exit(1);
  }

  const server = buildServer(app);
  await server.connect(new StdioServerTransport());
}
