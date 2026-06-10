#!/usr/bin/env node
import { Command } from 'commander';
import { register as registerServe } from './commands/serve.js';
import { register as registerRooms } from './commands/rooms.js';
import { register as registerSync } from './commands/sync.js';
import { register as registerMessages } from './commands/messages.js';
import { register as registerSearch } from './commands/search.js';
import { register as registerSend } from './commands/send.js';
import { register as registerThreads } from './commands/threads.js';
import { register as registerWatch } from './commands/watch.js';
import { register as registerUpload } from './commands/upload.js';
import { register as registerDownload } from './commands/download.js';
import { register as registerEmojis } from './commands/emojis.js';

const program = new Command();

program
  .name('rocket-cli')
  .version('0.1.0')
  .description('Rocket.Chat CLI + MCP server with local SQLite/FTS5 cache')
  .option('--json', 'machine-readable JSON output (passed through to subcommands)');

registerServe(program);
registerRooms(program);
registerSync(program);
registerMessages(program);
registerSearch(program);
registerSend(program);
registerThreads(program);
registerWatch(program);
registerUpload(program);
registerDownload(program);
registerEmojis(program);

program.parse(process.argv);
