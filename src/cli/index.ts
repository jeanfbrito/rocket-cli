#!/usr/bin/env node
import { Command } from 'commander';
import { register as registerServe } from './commands/serve.js';
import { register as registerRooms } from './commands/rooms.js';
import { register as registerSync } from './commands/sync.js';
import { register as registerMessages } from './commands/messages.js';
import { register as registerUnread } from './commands/unread.js';
import { register as registerMentions } from './commands/mentions.js';
import { register as registerContext } from './commands/context.js';
import { register as registerOpen } from './commands/open.js';
import { register as registerAttention } from './commands/attention.js';
import { register as registerSearch } from './commands/search.js';
import { register as registerSend } from './commands/send.js';
import { register as registerThreads } from './commands/threads.js';
import { register as registerWatch } from './commands/watch.js';
import { register as registerUpload } from './commands/upload.js';
import { register as registerDownload } from './commands/download.js';
import { register as registerEmojis } from './commands/emojis.js';
import { register as registerProfiles } from './commands/profiles.js';
import { setActiveProfile } from './commands/util.js';

const program = new Command();

// Resolve the global --profile flag once, before any command action runs, and
// hand it to the shared App factory (used by every withApp call).
program.hook('preAction', (_thisCommand, actionCommand) => {
  const profile = actionCommand.optsWithGlobals<{ profile?: string }>().profile;
  setActiveProfile(profile);
});

program
  .name('rocket-cli')
  .version('0.1.0')
  .description('Rocket.Chat CLI + MCP server with local SQLite/FTS5 cache')
  .option('--json', 'machine-readable JSON output (passed through to subcommands)')
  .option('--profile <name>', 'use a named connection profile (or set ROCKET_CLI_PROFILE)');

registerServe(program);
registerRooms(program);
registerSync(program);
registerMessages(program);
registerUnread(program);
registerSearch(program);
registerSend(program);
registerThreads(program);
registerWatch(program);
registerUpload(program);
registerDownload(program);
registerEmojis(program);
registerMentions(program);
registerContext(program);
registerOpen(program);
registerAttention(program);
registerProfiles(program);

program.parse(process.argv);
