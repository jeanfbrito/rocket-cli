import type { Command } from 'commander';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ConfigError,
  profilesPath,
  readProfileStore,
  writeProfileStore,
  type ProfileEntry,
  type ProfileStore,
} from '../../core/config.js';
import { printTable } from './util.js';

/** Per-profile default db path, mirroring loadConfig's derivation. */
function profileDbPath(name: string): string {
  const base = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(base, 'rocket-cli', `${name}.db`);
}

export function register(program: Command): void {
  program
    .command('profiles')
    .description('List or manage named Rocket.Chat connection profiles')
    .option('--add <name>', 'add/replace a profile (requires --url, --token, --user-id)')
    .option('--url <url>', 'server URL (with --add)')
    .option('--token <token>', 'personal access token (with --add)')
    .option('--user-id <id>', 'user id (with --add)')
    .option('--read-only', 'mark the profile read-only (with --add)')
    .option('--default <name>', 'set the default profile')
    .action(
      async (opts: {
        add?: string;
        url?: string;
        token?: string;
        userId?: string;
        readOnly?: boolean;
        default?: string;
      }) => {
        try {
          // ---- mutating actions: --add and --default --------------------
          if (opts.add !== undefined || opts.default !== undefined) {
            const store: ProfileStore = readProfileStore() ?? { profiles: {} };

            if (opts.add !== undefined) {
              const name = opts.add;
              if (!opts.url || !opts.token || !opts.userId) {
                throw new ConfigError(
                  `profiles --add <name> requires --url, --token, and --user-id.`,
                );
              }
              const entry: ProfileEntry = {
                url: opts.url.replace(/\/+$/, ''),
                token: opts.token,
                userId: opts.userId,
              };
              if (opts.readOnly) entry.readOnly = true;
              store.profiles[name] = entry;
            }

            if (opts.default !== undefined) {
              if (!store.profiles[opts.default]) {
                const names = Object.keys(store.profiles);
                const list = names.length > 0 ? names.join(', ') : '(none)';
                throw new ConfigError(
                  `Cannot set default to unknown profile '${opts.default}'. ` +
                    `Available: ${list}.`,
                );
              }
              store.defaultProfile = opts.default;
            }

            writeProfileStore(store);
            process.stdout.write(`Wrote ${profilesPath()} (mode 600).\n`);
            return;
          }

          // ---- list (default) -------------------------------------------
          const store = readProfileStore();
          if (!store || Object.keys(store.profiles).length === 0) {
            process.stdout.write(
              `No profiles configured. Add one with:\n` +
                `  rocket-cli profiles --add <name> --url <u> --token <t> --user-id <id> [--read-only]\n` +
                `Stored at ${profilesPath()}\n`,
            );
            return;
          }

          const header = ['', 'NAME', 'URL', 'DB PATH', 'READ-ONLY'];
          const rows = Object.entries(store.profiles).map(([name, e]) => [
            store.defaultProfile === name ? '*' : '',
            name,
            e.url,
            e.db ?? profileDbPath(name),
            e.readOnly ? 'yes' : 'no',
          ]);
          printTable([header, ...rows]);
          process.stdout.write(`\nStored at ${profilesPath()} ('*' = default). Tokens not shown.\n`);
        } catch (err) {
          if (err instanceof ConfigError) {
            process.stderr.write(`${err.message}\n`);
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`${msg}\n`);
          }
          process.exitCode = 1;
        }
      },
    );
}
