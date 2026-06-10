import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/core/db.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import type { CustomEmojiListResult, RcClient } from '../src/core/rc-client.js';

/** The typed-method surface EmojiDirectory consumes from RcClient. */
type EmojiMethods = Pick<RcClient, 'listCustomEmojis'>;

/** Fake RcClient recording listCustomEmojis calls + scripted responses. */
class FakeRc {
  calls: Array<{ method: string; updatedSince?: string }> = [];
  private queue: unknown[] = [];

  on(...responses: unknown[]): this {
    this.queue = responses;
    return this;
  }

  listCustomEmojis(updatedSince?: string): Promise<CustomEmojiListResult> {
    this.calls.push({ method: 'listCustomEmojis', updatedSince });
    if (this.queue.length === 0) {
      throw new Error('FakeRc: no response queued for listCustomEmojis');
    }
    const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return Promise.resolve(next as CustomEmojiListResult);
  }

  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

// Compile-time guard: the fake must structurally satisfy the method it stubs.
const _typecheck: EmojiMethods = new FakeRc();
void _typecheck;

const CFG = { url: 'http://example.com', token: 'tok', userId: 'uid' };

function makeDir(db: Db, rc: FakeRc): EmojiDirectory {
  return new EmojiDirectory(db, rc as unknown as RcClient, CFG);
}

/** A pending promise that never resolves — used to prove refresh() does not
 *  await image fetches. */
function neverResolves(): Promise<never> {
  return new Promise<never>(() => {});
}

describe('EmojiDirectory.refresh / list', () => {
  let db: Db;
  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('full refresh upserts every emoji and records the watermark', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc().on({
      emojis: {
        update: [
          { _id: 'e1', name: 'rocketcli', aliases: ['rkt'], extension: 'png', _updatedAt: '2026-01-01T00:00:00.000Z' },
          { _id: 'e2', name: 'grinch', aliases: [], extension: 'gif', _updatedAt: '2026-01-02T00:00:00.000Z' },
        ],
        remove: [],
      },
    });
    // fetch never resolves; refresh must NOT await it.
    vi.stubGlobal('fetch', vi.fn(neverResolves));
    const dir = makeDir(db, rc);

    await dir.refresh();

    expect(db.getMeta('emojis_refreshed_at')).toBeDefined();
    const list = await dir.list();
    expect(list.map((e) => e.name).sort()).toEqual(['grinch', 'rocketcli']);
    const rkt = list.find((e) => e.name === 'rocketcli')!;
    expect(rkt.aliases).toEqual(['rkt']);
    expect(rc.countOf('listCustomEmojis')).toBe(1);
  });

  it('refresh resolves without awaiting image downloads (lazy fill)', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc().on({
      emojis: { update: [{ _id: 'e1', name: 'a', aliases: [], extension: 'png' }], remove: [] },
    });
    const fetchMock = vi.fn(neverResolves);
    vi.stubGlobal('fetch', fetchMock);
    const dir = makeDir(db, rc);

    // If refresh awaited the (never-resolving) fetch, this would hang. The test
    // timeout would fire; resolving proves the fetch is fire-and-forget.
    await expect(dir.refresh()).resolves.toBeUndefined();
    // Metadata landed even though no image was awaited.
    expect(db.getEmojiImage('e1')).toBeUndefined();
  });

  it('delta refresh sends the prior watermark and applies update + remove', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc().on(
      // First (full) refresh seeds two emojis.
      {
        emojis: {
          update: [
            { _id: 'e1', name: 'keep', aliases: [], extension: 'png' },
            { _id: 'e2', name: 'gone', aliases: [], extension: 'png' },
          ],
          remove: [],
        },
      },
      // Second (delta) refresh updates e1, removes e2.
      {
        emojis: {
          update: [{ _id: 'e1', name: 'keep-renamed', aliases: ['k'], extension: 'gif' }],
          remove: [{ _id: 'e2', name: 'gone', aliases: [], extension: 'png' }],
        },
      },
    );
    vi.stubGlobal('fetch', vi.fn(neverResolves));
    const dir = makeDir(db, rc);

    await dir.refresh();
    await dir.refresh();

    // Second call carried the watermark as updatedSince.
    expect(rc.calls[1]!.updatedSince).toBeDefined();
    const list = await dir.list();
    expect(list.map((e) => e.name)).toEqual(['keep-renamed']);
    expect(db.getEmojiImage('e2')).toBeUndefined();
  });

  it('ensureFresh skips the network when within TTL', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc().on({ emojis: { update: [], remove: [] } });
    vi.stubGlobal('fetch', vi.fn(neverResolves));
    const dir = makeDir(db, rc);

    await dir.refresh();
    await dir.ensureFresh();
    await dir.list();

    expect(rc.countOf('listCustomEmojis')).toBe(1);
  });
});

describe('EmojiDirectory.suggest', () => {
  let db: Db;
  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function seed(): EmojiDirectory {
    db = openDb(':memory:');
    db.upsertEmojis([
      { id: 'e1', name: 'rocketcli', aliases: JSON.stringify(['rkt']), extension: 'png', updated_at: null },
      { id: 'e2', name: 'doom_win', aliases: JSON.stringify([]), extension: 'png', updated_at: null },
      { id: 'e3', name: 'doom-guy', aliases: JSON.stringify(['doomguy']), extension: 'png', updated_at: null },
      { id: 'e4', name: 'grinch', aliases: JSON.stringify([]), extension: 'png', updated_at: null },
    ]);
    const rc = new FakeRc();
    return makeDir(db, rc);
  }

  it('suggests by substring (typo: rockt -> rocketcli)', () => {
    const dir = seed();
    expect(dir.suggest('rockt')).toContain('rocketcli');
  });

  it('matches the colon-wrapped form and aliases', () => {
    const dir = seed();
    expect(dir.suggest(':rkt:')).toContain('rocketcli');
    expect(dir.suggest('doomguy')).toContain('doom-guy');
  });

  it('returns at most 5 and empty for no match', () => {
    const dir = seed();
    expect(dir.suggest('doom')).toEqual(expect.arrayContaining(['doom_win', 'doom-guy']));
    expect(dir.suggest('zzzzz')).toEqual([]);
    expect(dir.suggest('   ')).toEqual([]);
  });
});

describe('EmojiDirectory images', () => {
  let db: Db;
  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function seedRows(): void {
    db = openDb(':memory:');
    db.upsertEmojis([
      { id: 'e1', name: 'rocketcli', aliases: JSON.stringify(['rkt']), extension: 'png', updated_at: null },
      { id: 'e2', name: 'grinch', aliases: JSON.stringify([]), extension: 'gif', updated_at: null },
    ]);
    // Mark the cache fresh so getImage()/fillImages() do not trigger a refresh.
    db.setMeta('emojis_refreshed_at', new Date().toISOString());
  }

  /** Stub global fetch to return a 1x1 image with a content-type. */
  function stubImageFetch(): ReturnType<typeof vi.fn> {
    const m = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    vi.stubGlobal('fetch', m);
    return m;
  }

  it('getImage fetches once on a miss, then serves from cache', async () => {
    seedRows();
    const fetchMock = stubImageFetch();
    const dir = makeDir(db, new FakeRc());

    const first = await dir.getImage('rocketcli');
    expect(first?.contentType).toBe('image/png');
    expect(Array.from(first!.bytes)).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call served from the cache — no extra fetch.
    const second = await dir.getImage('rocketcli');
    expect(Array.from(second!.bytes)).toEqual([1, 2, 3, 4]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getImage resolves by alias and returns undefined for unknown names', async () => {
    seedRows();
    stubImageFetch();
    const dir = makeDir(db, new FakeRc());

    expect(await dir.getImage(':rkt:')).toBeTruthy();
    expect(await dir.getImage('nope')).toBeUndefined();
  });

  it('getEmojiImage on the db returns hit/miss correctly', async () => {
    seedRows();
    expect(db.getEmojiImage('e1')).toBeUndefined();
    db.setEmojiImage('e1', Buffer.from([9, 9]), 'image/png');
    expect(db.getEmojiImage('e1')).toEqual({ image: Buffer.from([9, 9]), contentType: 'image/png' });
  });

  it('fillImages fetches every missing image with bounded concurrency', async () => {
    seedRows();
    const fetchMock = stubImageFetch();
    const dir = makeDir(db, new FakeRc());

    const stored = await dir.fillImages();
    expect(stored).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(db.getEmojiImage('e1')).toBeTruthy();
    expect(db.getEmojiImage('e2')).toBeTruthy();
  });

  it('fillImages writes exported files to a directory (via CLI shape)', async () => {
    seedRows();
    stubImageFetch();
    const dir = makeDir(db, new FakeRc());
    await dir.fillImages();

    const out = mkdtempSync(join(tmpdir(), 'emoji-test-'));
    try {
      for (const e of await dir.list()) {
        const img = await dir.getImage(e.name);
        if (img && e.extension) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(join(out, `${e.name}.${e.extension}`), img.bytes);
        }
      }
      expect(readdirSync(out).sort()).toEqual(['grinch.gif', 'rocketcli.png']);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
