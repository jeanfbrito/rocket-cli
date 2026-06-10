// serve — launches the MCP stdio server.
// stdout discipline: nothing may be written to stdout here; the MCP transport
// owns stdout. All diagnostics go to stderr.
import type { Command } from 'commander';

export function register(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP stdio server (stdout is the MCP transport)')
    .option('--profile <name>', 'use a named connection profile (or set ROCKET_CLI_PROFILE)')
    .action(async (_opts: { profile?: string }, command: Command) => {
      try {
        const profile = command.optsWithGlobals<{ profile?: string }>().profile;
        const { runMcpServer } = await import('../../mcp/server.js');
        await runMcpServer(profile);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ERROR] MCP server failed: ${msg}\n`);
        process.exit(1);
      }
    });
}
