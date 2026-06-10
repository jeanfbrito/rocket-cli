import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDotEnv } from '../src/core/config.js';

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
