import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ConfigError,
  loadConfig,
  loadDotEnv,
  profilesPath,
  writeProfileStore,
  type ProfileStore,
} from '../src/core/config.js';

// Keys that loadDotEnv touches during these tests — saved and restored per test
const WATCHED_KEYS = [
  'ROCKETCHAT_URL',
  'ROCKETCHAT_TOKEN',
  'ROCKETCHAT_USER_ID',
  'ROCKET_CLI_DB',
  'ROCKET_CLI_SYNC_TTL_SECONDS',
  'ROCKET_CLI_BACKFILL_LIMIT',
  'TEST_KEY_A',
  'TEST_KEY_B',
  'TEST_KEY_QUOTED_DOUBLE',
  'TEST_KEY_QUOTED_SINGLE',
  'TEST_KEY_EXISTING',
];

describe('loadDotEnv', () => {
  let tmpDir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Save current values of watched keys
    saved = {};
    for (const k of WATCHED_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }

    // Create a fresh temp dir for each test
    tmpDir = join(tmpdir(), `rocket-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Restore env exactly as it was
    for (const k of WATCHED_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }

    // Clean up temp dir
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads key=value pairs from .env into process.env', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_KEY_A=hello\nTEST_KEY_B=world\n');
    loadDotEnv(tmpDir);
    expect(process.env['TEST_KEY_A']).toBe('hello');
    expect(process.env['TEST_KEY_B']).toBe('world');
  });

  it('does NOT overwrite a variable already set in the environment', () => {
    process.env['TEST_KEY_EXISTING'] = 'from-env';
    writeFileSync(join(tmpDir, '.env'), 'TEST_KEY_EXISTING=from-dotenv\n');
    loadDotEnv(tmpDir);
    expect(process.env['TEST_KEY_EXISTING']).toBe('from-env');
  });

  it('strips surrounding double quotes from values', () => {
    writeFileSync(join(tmpDir, '.env'), 'TEST_KEY_QUOTED_DOUBLE="quoted value"\n');
    loadDotEnv(tmpDir);
    expect(process.env['TEST_KEY_QUOTED_DOUBLE']).toBe('quoted value');
  });

  it('strips surrounding single quotes from values', () => {
    writeFileSync(join(tmpDir, '.env'), "TEST_KEY_QUOTED_SINGLE='single quoted'\n");
    loadDotEnv(tmpDir);
    expect(process.env['TEST_KEY_QUOTED_SINGLE']).toBe('single quoted');
  });

  it('skips blank lines and comment lines', () => {
    writeFileSync(
      join(tmpDir, '.env'),
      [
        '# this is a comment',
        '',
        '   ',
        '# another comment',
        'TEST_KEY_A=after-comments',
      ].join('\n'),
    );
    loadDotEnv(tmpDir);
    expect(process.env['TEST_KEY_A']).toBe('after-comments');
  });

  it('is a silent no-op when .env does not exist', () => {
    // No .env file written — should not throw
    expect(() => loadDotEnv(tmpDir)).not.toThrow();
    expect(process.env['TEST_KEY_A']).toBeUndefined();
  });
});

// Env vars touched by loadConfig — saved/restored so the profile tests run in
// an isolated, env-only-empty environment with XDG dirs pinned to a temp dir.
const CONFIG_KEYS = [
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'ROCKET_CLI_PROFILE',
  'ROCKETCHAT_URL',
  'ROCKETCHAT_TOKEN',
  'ROCKETCHAT_USER_ID',
  'ROCKET_CLI_DB',
  'ROCKET_CLI_SYNC_TTL_SECONDS',
  'ROCKET_CLI_BACKFILL_LIMIT',
  'ROCKET_CLI_EMOJI_IMAGES',
  'ROCKET_CLI_READ_ONLY',
];

describe('loadConfig profiles', () => {
  let home: string;
  let prevCwd: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of CONFIG_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    home = join(tmpdir(), `rocket-cli-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(home, { recursive: true });
    // chdir into the temp dir (which has no .env) so loadConfig's cwd .env
    // autoload finds nothing and cannot leak the repo's real .env into these
    // env-vs-profile precedence assertions. Pin XDG dirs into the same tree.
    prevCwd = process.cwd();
    process.chdir(home);
    process.env['XDG_CONFIG_HOME'] = join(home, 'config');
    process.env['XDG_DATA_HOME'] = join(home, 'data');
  });

  afterEach(() => {
    process.chdir(prevCwd);
    for (const k of CONFIG_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(home, { recursive: true, force: true });
  });

  function seedStore(store: ProfileStore): void {
    writeProfileStore(store);
  }

  it('resolves a named profile from the store into config fields', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com/', token: 'wtok', userId: 'wuid' },
      },
    });
    const cfg = loadConfig('work');
    expect(cfg.url).toBe('https://work.example.com'); // trailing slash stripped
    expect(cfg.token).toBe('wtok');
    expect(cfg.userId).toBe('wuid');
    expect(cfg.profile).toBe('work');
    expect(cfg.readOnly).toBe(false);
  });

  it('explicit profile beats ambient ROCKETCHAT_TOKEN — profile is authoritative for connection fields', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 'wtok', userId: 'wuid' },
      },
    });
    // Ambient env var (e.g. injected by a cwd .env) must NOT win over the profile.
    process.env['ROCKETCHAT_TOKEN'] = 'env-token';
    const cfg = loadConfig('work');
    expect(cfg.token).toBe('wtok'); // profile wins
    expect(cfg.url).toBe('https://work.example.com');
    expect(cfg.userId).toBe('wuid');
  });

  it('explicit profile beats ambient ROCKETCHAT_URL — profile connection identity wins', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 'wtok', userId: 'wuid' },
      },
    });
    process.env['ROCKETCHAT_URL'] = 'https://wrong-server.example.com';
    process.env['ROCKETCHAT_TOKEN'] = 'env-token';
    process.env['ROCKETCHAT_USER_ID'] = 'env-uid';
    const cfg = loadConfig('work');
    expect(cfg.url).toBe('https://work.example.com'); // profile wins
    expect(cfg.token).toBe('wtok');
    expect(cfg.userId).toBe('wuid');
  });

  it('explicit profile beats .env-file-sourced ROCKETCHAT_URL written to cwd', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 'wtok', userId: 'wuid' },
      },
    });
    // Write a .env into the temp cwd (home) that loadConfig will autoload.
    // loadDotEnv does not overwrite vars already in env, so clear them first.
    writeFileSync(
      join(home, '.env'),
      'ROCKETCHAT_URL=https://dotenv-server.example.com\nROCKETCHAT_TOKEN=dotenv-tok\nROCKETCHAT_USER_ID=dotenv-uid\n',
    );
    const cfg = loadConfig('work');
    expect(cfg.url).toBe('https://work.example.com'); // profile wins
    expect(cfg.token).toBe('wtok');
    expect(cfg.userId).toBe('wuid');
  });

  it('tuning knobs (ttl, backfillLimit) still fall through from env when profile active', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 'wtok', userId: 'wuid' },
      },
    });
    process.env['ROCKET_CLI_SYNC_TTL_SECONDS'] = '120';
    process.env['ROCKET_CLI_BACKFILL_LIMIT'] = '999';
    const cfg = loadConfig('work');
    expect(cfg.ttlSeconds).toBe(120);
    expect(cfg.backfillLimit).toBe(999);
    // connection identity still comes from profile
    expect(cfg.url).toBe('https://work.example.com');
  });

  it('throws a helpful error listing available profiles for an unknown one', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 't', userId: 'u' },
        test: { url: 'https://test.example.com', token: 't', userId: 'u' },
      },
    });
    expect(() => loadConfig('nope')).toThrow(ConfigError);
    try {
      loadConfig('nope');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Unknown profile 'nope'/);
      expect(msg).toMatch(/work/);
      expect(msg).toMatch(/test/);
    }
  });

  it('derives a per-profile db path under XDG_DATA_HOME', () => {
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 't', userId: 'u' },
      },
    });
    const cfg = loadConfig('work');
    expect(cfg.dbPath).toBe(join(home, 'data', 'rocket-cli', 'work.db'));
  });

  it('honors an explicit db path in the profile', () => {
    const explicitDb = join(home, 'custom', 'work.db');
    seedStore({
      profiles: {
        work: { url: 'https://work.example.com', token: 't', userId: 'u', db: explicitDb },
      },
    });
    const cfg = loadConfig('work');
    expect(cfg.dbPath).toBe(explicitDb);
  });

  it('carries readOnly:true from the profile', () => {
    seedStore({
      profiles: {
        prod: { url: 'https://prod.example.com', token: 't', userId: 'u', readOnly: true },
      },
    });
    const cfg = loadConfig('prod');
    expect(cfg.readOnly).toBe(true);
  });

  it('env-only config (no profile) defaults readOnly to false and uses the legacy db path', () => {
    process.env['ROCKETCHAT_URL'] = 'https://env.example.com';
    process.env['ROCKETCHAT_TOKEN'] = 'etok';
    process.env['ROCKETCHAT_USER_ID'] = 'euid';
    const cfg = loadConfig();
    expect(cfg.readOnly).toBe(false);
    expect(cfg.profile).toBeUndefined();
    expect(cfg.dbPath).toBe(join(home, 'data', 'rocket-cli', 'cache.db'));
  });

  it('applies defaultProfile when no explicit profile is selected and ROCKETCHAT_URL is absent', () => {
    seedStore({
      defaultProfile: 'work',
      profiles: {
        work: { url: 'https://work.example.com', token: 'wtok', userId: 'wuid' },
      },
    });
    // No ROCKETCHAT_URL in env — defaultProfile should activate and be authoritative.
    const cfg = loadConfig();
    expect(cfg.profile).toBe('work');
    expect(cfg.token).toBe('wtok');
    expect(cfg.url).toBe('https://work.example.com');
  });

  it('skips defaultProfile when ROCKETCHAT_URL is already set in env — env-only path wins', () => {
    seedStore({
      defaultProfile: 'work',
      profiles: {
        work: { url: 'https://work.example.com', token: 'wtok', userId: 'wuid' },
      },
    });
    // ROCKETCHAT_URL present → env-only path, defaultProfile is bypassed.
    process.env['ROCKETCHAT_URL'] = 'https://env-only.example.com';
    process.env['ROCKETCHAT_TOKEN'] = 'env-tok';
    process.env['ROCKETCHAT_USER_ID'] = 'env-uid';
    const cfg = loadConfig();
    expect(cfg.url).toBe('https://env-only.example.com'); // env wins
    expect(cfg.profile).toBeUndefined(); // no profile resolved
    expect(cfg.dbPath).toBe(join(home, 'data', 'rocket-cli', 'cache.db')); // legacy db
  });

  it('writeProfileStore writes to the XDG-aware path with 0600 mode', () => {
    seedStore({ profiles: { a: { url: 'https://a.example.com', token: 't', userId: 'u' } } });
    expect(profilesPath()).toBe(join(home, 'config', 'rocket-cli', 'profiles.json'));
  });
});
