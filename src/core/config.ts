import { z } from 'zod';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Parse and load a .env file from `dir` into process.env.
 * Existing environment variables are never overwritten (real env wins).
 * Silent no-op when the file is missing or unreadable.
 */
export function loadDotEnv(dir: string): void {
  let text: string;
  try {
    text = readFileSync(join(dir, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Strip optional surrounding single or double quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Never overwrite vars already set in the environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

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
  /** Whether to cache custom-emoji image bytes (lazy fetch + background fill).
   *  When false, only emoji metadata (names/aliases) is cached. */
  emojiImages: z.boolean(),
  /** When true, every write path (send/react/upload/notify) is refused. The
   *  safety mode for production/company servers. Defaults to false. */
  readOnly: z.boolean(),
  /** Name of the resolved named profile, if any (informational; used in
   *  read-only refusal messages). Undefined when running on raw env vars. */
  profile: z.string().optional(),
});

export type Config = z.output<typeof configSchema>;

/** A server-mutating capability a profile may or may not be permitted to use. */
export type Capability = 'send' | 'react' | 'upload';

/**
 * Single authority for "may this config perform write capability X?". Today the
 * only gate is `readOnly` (true = no write capabilities at all). This is
 * deliberately the ONE check site so the planned per-profile capability sets
 * (e.g. `permissions: ['read','react']`) can be added by changing only this
 * function's internals — every call site (MCP tools, CLI commands, seed)
 * already names its capability and will not need to move.
 */
export function isAllowed(config: Config, _capability: Capability): boolean {
  return !config.readOnly;
}

/** Shape of a single named profile in the profile store. */
export interface ProfileEntry {
  url: string;
  token: string;
  userId: string;
  db?: string;
  readOnly?: boolean;
  syncTtlSeconds?: number;
  backfillLimit?: number;
  emojiImages?: boolean;
}

/** Shape of `~/.config/rocket-cli/profiles.json`. */
export interface ProfileStore {
  defaultProfile?: string;
  profiles: Record<string, ProfileEntry>;
}

function xdgConfigHome(): string {
  return process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
}

function xdgDataHome(): string {
  return process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
}

/** Absolute path to the profile store file (XDG_CONFIG_HOME aware). */
export function profilesPath(): string {
  return join(xdgConfigHome(), 'rocket-cli', 'profiles.json');
}

function defaultDbPath(): string {
  return join(xdgDataHome(), 'rocket-cli', 'cache.db');
}

/** Per-profile default db path: `~/.local/share/rocket-cli/<profile>.db`. */
function profileDbPath(profileName: string): string {
  return join(xdgDataHome(), 'rocket-cli', `${profileName}.db`);
}

/**
 * Read and parse the profile store. Returns undefined when the file does not
 * exist (no profiles configured). Throws ConfigError on parse/shape errors so
 * the failure is reported clearly rather than crashing later.
 */
export function readProfileStore(): ProfileStore | undefined {
  const path = profilesPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not parse profile store at ${path}: ${msg}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as ProfileStore).profiles !== 'object' ||
    (parsed as ProfileStore).profiles === null
  ) {
    throw new ConfigError(
      `Malformed profile store at ${path}: expected an object with a "profiles" map.`,
    );
  }
  return parsed as ProfileStore;
}

/** Write the profile store atomically with owner-only (0600) permissions. */
export function writeProfileStore(store: ProfileStore): void {
  const path = profilesPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Resolve which profile (if any) applies, then build the Config.
 *
 * Precedence rules (new — fixes env-file cwd contamination of explicit profiles):
 *
 *   CONNECTION IDENTITY (url, token, userId, db):
 *     a. Explicit profile selected (--profile / ROCKET_CLI_PROFILE):
 *        Profile values are AUTHORITATIVE. .env-sourced and ambient
 *        ROCKETCHAT_* / ROCKET_CLI_DB env vars are ignored for these fields.
 *        This prevents a cwd .env from silently overriding the chosen server.
 *     b. defaultProfile applies when no explicit selection AND ROCKETCHAT_URL
 *        is absent from the environment (env-only legacy setups remain intact).
 *        When it does apply it is authoritative for the same fields as (a).
 *     c. No profile active: env vars supply all fields exactly as before
 *        (full backcompat); db defaults to ~/.local/share/rocket-cli/cache.db.
 *
 *   TUNING KNOBS (ttl, backfillLimit, emojiImages, readOnly):
 *     Env vars still override the profile's knob values (or supply defaults)
 *     regardless of whether a profile is active.
 *
 * A profile always gets its own db path (never shared): explicit `db` in the
 * profile, else `~/.local/share/rocket-cli/<profile>.db`.
 */
export function loadConfig(profileName?: string): Config {
  loadDotEnv(process.cwd());

  const explicit = profileName ?? process.env['ROCKET_CLI_PROFILE'] ?? undefined;

  let entry: ProfileEntry | undefined;
  let resolvedName: string | undefined;
  // Whether a profile is active and should be authoritative for connection fields.
  let profileIsAuthoritative = false;

  if (explicit) {
    // An explicitly selected profile MUST exist — error if it doesn't.
    const store = readProfileStore();
    const available = store ? Object.keys(store.profiles) : [];
    entry = store?.profiles[explicit];
    if (!entry) {
      const list = available.length > 0 ? available.join(', ') : '(none configured)';
      throw new ConfigError(
        `Unknown profile '${explicit}'. Available profiles: ${list}. ` +
          `Configured in ${profilesPath()}.`,
      );
    }
    resolvedName = explicit;
    profileIsAuthoritative = true;
  } else {
    // No explicit selection: fall back to the store's defaultProfile ONLY when
    // ROCKETCHAT_URL is absent from the environment — this preserves the
    // env-only legacy path byte-for-byte (no behavior change for existing users
    // who rely on .env / ambient env vars and have no profiles configured).
    const store = readProfileStore();
    if (store?.defaultProfile && !process.env['ROCKETCHAT_URL']) {
      entry = store.profiles[store.defaultProfile];
      if (!entry) {
        const list = Object.keys(store.profiles).join(', ') || '(none configured)';
        throw new ConfigError(
          `Default profile '${store.defaultProfile}' is not defined. ` +
            `Available profiles: ${list}. Configured in ${profilesPath()}.`,
        );
      }
      resolvedName = store.defaultProfile;
      profileIsAuthoritative = true;
    }
  }

  // Connection identity: when a profile is authoritative, its fields WIN over
  // any env var (including those injected by the cwd .env autoload). When no
  // profile is active, env vars supply the values exactly as before.
  const url = profileIsAuthoritative
    ? (entry!.url ?? '')
    : (process.env['ROCKETCHAT_URL'] ?? entry?.url ?? '');
  const token = profileIsAuthoritative
    ? (entry!.token ?? '')
    : (process.env['ROCKETCHAT_TOKEN'] ?? entry?.token ?? '');
  const userId = profileIsAuthoritative
    ? (entry!.userId ?? '')
    : (process.env['ROCKETCHAT_USER_ID'] ?? entry?.userId ?? '');

  // db path: when profile is authoritative, profile's own db field wins, then
  // the per-profile default. Env ROCKET_CLI_DB is only consulted in the no-profile path.
  const dbPath = profileIsAuthoritative
    ? (entry!.db || profileDbPath(resolvedName!))
    : (process.env['ROCKET_CLI_DB'] ||
        entry?.db ||
        (resolvedName ? profileDbPath(resolvedName) : defaultDbPath()));

  const ttlSeconds = Number(
    process.env['ROCKET_CLI_SYNC_TTL_SECONDS'] ?? entry?.syncTtlSeconds ?? 60,
  );
  const backfillLimit = Number(
    process.env['ROCKET_CLI_BACKFILL_LIMIT'] ?? entry?.backfillLimit ?? 500,
  );

  // Boolean-ish: only 'false' / '0' disable; anything else is true. When the
  // env var is unset, fall back to the profile value, then the default (true).
  const emojiImagesEnv = process.env['ROCKET_CLI_EMOJI_IMAGES'];
  const emojiImages =
    emojiImagesEnv !== undefined
      ? !['false', '0'].includes(emojiImagesEnv.trim().toLowerCase())
      : (entry?.emojiImages ?? true);

  // readOnly: env override wins, else the profile value, else false.
  const readOnlyEnv = process.env['ROCKET_CLI_READ_ONLY'];
  const readOnly =
    readOnlyEnv !== undefined
      ? ['true', '1'].includes(readOnlyEnv.trim().toLowerCase())
      : (entry?.readOnly ?? false);

  const raw = {
    url,
    token,
    userId,
    dbPath,
    ttlSeconds,
    backfillLimit,
    emojiImages,
    readOnly,
    profile: resolvedName,
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((i) => i.message).join('; ');
    throw new ConfigError(`Configuration error: ${messages}`);
  }

  mkdirSync(dirname(result.data.dbPath), { recursive: true });

  return result.data;
}
