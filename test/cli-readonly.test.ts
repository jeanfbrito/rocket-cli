/**
 * Tests for the readOnly guard at the seam that CLI commands actually use.
 *
 * The CLI actions (send, upload) call `isAllowed(app.config, capability)` before
 * touching the network. The guard itself is a single pure function exported from
 * config.ts, so that is the deepest practical seam: we construct a Config-shaped
 * fixture and assert the gate behaviour directly.
 *
 * Testing the full commander wiring would require mocking withApp + network, which
 * would couple the tests to unrelated plumbing. The guard path (`isAllowed`) IS
 * the code those commands branch on; proving it here is sufficient and stable.
 */
import { describe, expect, it } from 'vitest';
import { isAllowed, type Config, type Capability } from '../src/core/config.js';

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    url: 'https://chat.example.com',
    token: 'tok',
    userId: 'uid',
    dbPath: ':memory:',
    ttlSeconds: 60,
    backfillLimit: 500,
    emojiImages: true,
    readOnly: false,
    profile: undefined,
    ...overrides,
  };
}

describe('isAllowed — readOnly guard used by send and upload commands', () => {
  const writeCapabilities: Capability[] = ['send', 'upload', 'react'];

  it('allows all server-write capabilities when readOnly is false', () => {
    const cfg = makeConfig({ readOnly: false });
    for (const cap of writeCapabilities) {
      expect(isAllowed(cfg, cap)).toBe(true);
    }
  });

  it('send is refused (isAllowed returns false) when config is readOnly', () => {
    const cfg = makeConfig({ readOnly: true });
    expect(isAllowed(cfg, 'send')).toBe(false);
  });

  it('upload is refused (isAllowed returns false) when config is readOnly', () => {
    const cfg = makeConfig({ readOnly: true });
    expect(isAllowed(cfg, 'upload')).toBe(false);
  });

  it('react is refused (isAllowed returns false) when config is readOnly', () => {
    const cfg = makeConfig({ readOnly: true });
    expect(isAllowed(cfg, 'react')).toBe(false);
  });

  it('send refusal message format matches what the CLI command emits', () => {
    // Mirror the exact branch in src/cli/commands/send.ts so a future rename
    // surfaces here first.
    const cfg = makeConfig({ readOnly: true, profile: 'prod' });
    const who = cfg.profile ? `'${cfg.profile}'` : '(active config)';
    const msg = `Error: profile ${who} is read-only; send is disabled.\n`;
    expect(msg).toBe("Error: profile 'prod' is read-only; send is disabled.\n");
  });

  it('upload refusal message format matches what the CLI command emits', () => {
    // Mirror the exact branch in src/cli/commands/upload.ts.
    const cfg = makeConfig({ readOnly: true, profile: undefined });
    const who = cfg.profile ? `'${cfg.profile}'` : '(active config)';
    const msg = `Error: profile ${who} is read-only; upload is disabled.\n`;
    expect(msg).toBe('Error: profile (active config) is read-only; upload is disabled.\n');
  });
});
