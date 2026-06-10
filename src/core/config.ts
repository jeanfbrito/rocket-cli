import { z } from 'zod';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const configSchema = z.object({
  url: z
    .string()
    .min(1, 'ROCKETCHAT_URL is required')
    .url('ROCKETCHAT_URL must be a valid http(s) URL')
    .transform((u) => u.replace(/\/+$/, '')),
  token: z.string().min(1, 'ROCKETCHAT_TOKEN is required'),
  userId: z.string().min(1, 'ROCKETCHAT_USER_ID is required'),
  dbPath: z.string(),
  ttlSeconds: z.number().int().positive(),
  backfillLimit: z.number().int().positive(),
});

export type Config = z.output<typeof configSchema>;

function defaultDbPath(): string {
  const xdgData = process.env['XDG_DATA_HOME'];
  const base = xdgData ?? join(homedir(), '.local', 'share');
  return join(base, 'rocket-cli', 'cache.db');
}

export function loadConfig(): Config {
  const raw = {
    url: process.env['ROCKETCHAT_URL'] ?? '',
    token: process.env['ROCKETCHAT_TOKEN'] ?? '',
    userId: process.env['ROCKETCHAT_USER_ID'] ?? '',
    dbPath: process.env['ROCKET_CLI_DB'] || defaultDbPath(),
    ttlSeconds: Number(process.env['ROCKET_CLI_SYNC_TTL_SECONDS'] ?? '60'),
    backfillLimit: Number(process.env['ROCKET_CLI_BACKFILL_LIMIT'] ?? '500'),
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('; ');
    throw new ConfigError(`Configuration error: ${messages}`);
  }

  mkdirSync(dirname(result.data.dbPath), { recursive: true });

  return result.data;
}
