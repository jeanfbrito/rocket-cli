// serve — launches the MCP stdio server.
// stdout discipline: nothing may be written to stdout here; the MCP transport
// owns stdout. All diagnostics go to stderr.
import type { Command } from 'commander';

export function register(program: Command): void {
  program
    .command('serve')
    .description('Start the MCP stdio server (stdout is the MCP transport)')
    .action(async () => {
      try {
        const { runMcpServer } = await import('../../mcp/server.js');
        await runMcpServer();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[ERROR] MCP server failed: ${msg}\n`);
        process.exit(1);
      }
    });
}
