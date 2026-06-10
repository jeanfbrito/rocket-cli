// Shared CLI helpers: App lifecycle wrapper and table printer.
import { createApp, type App } from '../../core/app.js';
import { ConfigError } from '../../core/config.js';
import { log } from '../../core/log.js';

/**
 * The profile name resolved from the global `--profile` flag. Set once by the
 * CLI's preAction hook (see cli/index.ts) before any command action runs, so
 * every withApp call selects the same profile without threading the flag
 * through 16 action signatures. `loadConfig` still falls back to
 * ROCKET_CLI_PROFILE / defaultProfile when this is undefined.
 */
let activeProfile: string | undefined;

/** Set the active profile (called by the CLI preAction hook). */
export function setActiveProfile(name: string | undefined): void {
  activeProfile = name;
}

/**
 * Create the App, run `fn`, and ensure the DB is closed on exit.
 * On ConfigError prints the message without a stack trace and exits 1.
 * On other errors, logs via stderr and sets exitCode = 1.
 *
 * The profile selected by the global `--profile` flag is applied automatically.
 */
export async function withApp(fn: (app: App) => Promise<void>): Promise<void> {
  let app: App | undefined;
  try {
    app = createApp(undefined, activeProfile);
    await fn(app);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      process.exitCode = 1;
    }
  } finally {
    app?.db.close();
  }
}

/**
 * Print a 2D string array as aligned columns separated by two spaces.
 * The first row is treated as a header and printed as-is (caller decides
 * whether to include one).
 */
export function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const cols = rows[0]!.length;
  const widths: number[] = Array.from({ length: cols }, () => 0);
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      const w = (row[c] ?? '').length;
      if (w > widths[c]!) widths[c] = w;
    }
  }
  for (const row of rows) {
    const line = row
      .map((cell, c) => (c < cols - 1 ? (cell ?? '').padEnd(widths[c]!) : (cell ?? '')))
      .join('  ');
    process.stdout.write(line + '\n');
  }
}
