import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { RoomDirectory } from '../src/core/rooms.js';
import type { RcSubscription } from '../src/core/normalize.js';

/** A fake RcClient that records GET calls and returns scripted responses. */
class FakeRc {
  calls: Array<{ endpoint: string; params?: Record<string, unknown> }> = [];
  // Endpoint -> queued responses (shift on each call; last reused if drained).
  private responses = new Map<string, unknown[]>();

  on(endpoint: string, ...responses: unknown[]): this {
    this.responses.set(endpoint, responses);
    return this;
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ endpoint, params });
    const queue = this.responses.get(endpoint);
    if (!queue || queue.length === 0) {
      throw new Error(`FakeRc: no response queued for ${endpoint}`);
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next as T;
  }

  async post<T>(): Promise<T> {
    throw new Error('FakeRc.post not implemented');
  }

  countOf(endpoint: string): number {
    return this.calls.filter((c) => c.endpoint === endpoint).length;
  }
}

function sub(over: Partial<RcSubscription>): RcSubscription {
  return { rid: 'r', name: 'name', fname: 'fname', t: 'c', unread: 0, ...over };
}

const SUBS = '/v1/subscriptions.get';

describe('RoomDirectory.resolve', () => {
  let db: Db;
  afterEach(() => db?.close());

  function setup(subs: RcSubscription[], extra?: RcSubscription[][]): {
    rc: FakeRc;
    dir: RoomDirectory;
  } {
    db = openDb(':memory:');
    const rc = new FakeRc();
    // First response, then any extra refresh responses in order.
    rc.on(SUBS, { update: subs, remove: [] }, ...(extra ?? []).map((s) => ({ update: s, remove: [] })));
    const dir = new RoomDirectory(db, rc as never);
    return { rc, dir };
  }

  it('resolves an exact rid', async () => {
    const { dir } = setup([sub({ rid: 'GENERAL', name: 'general' })]);
    await dir.refresh();
    const room = await dir.resolve('GENERAL');
    expect(room.rid).toBe('GENERAL');
  });

  it('resolves #name (case-insensitive)', async () => {
    const { dir } = setup([sub({ rid: 'r1', name: 'general' })]);
    await dir.refresh();
    expect((await dir.resolve('#General')).rid).toBe('r1');
    expect((await dir.resolve('general')).rid).toBe('r1');
  });

  it('resolves by exact fname when name does not match', async () => {
    const { dir } = setup([sub({ rid: 'r1', name: 'eng-team', fname: 'Engineering Team' })]);
    await dir.refresh();
    expect((await dir.resolve('Engineering Team')).rid).toBe('r1');
  });

  it("resolves '@username' to its DM room", async () => {
    const { dir } = setup([
      sub({ rid: 'd1', name: 'bob', fname: 'Bob', t: 'd' }),
      sub({ rid: 'c1', name: 'bob', t: 'c' }), // same name but a channel
    ]);
    await dir.refresh();
    const room = await dir.resolve('@bob');
    expect(room.rid).toBe('d1');
    expect(room.t).toBe('d');
  });

  it('resolves a unique substring match', async () => {
    const { dir } = setup([
      sub({ rid: 'r1', name: 'product-design' }),
      sub({ rid: 'r2', name: 'engineering' }),
    ]);
    await dir.refresh();
    expect((await dir.resolve('design')).rid).toBe('r1');
  });

  it('throws listing candidates on ambiguous substring', async () => {
    const { dir } = setup([
      sub({ rid: 'r1', name: 'design-web' }),
      sub({ rid: 'r2', name: 'design-mobile' }),
    ]);
    await dir.refresh();
    await expect(dir.resolve('design')).rejects.toThrow(/ambiguous/i);
    await expect(dir.resolve('design')).rejects.toThrow(/design-web/);
    await expect(dir.resolve('design')).rejects.toThrow(/design-mobile/);
  });

  it('refreshes once on a miss, then resolves the newly-arrived room', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    // Initial refresh: empty. Second refresh (triggered by the miss): has it.
    rc.on(
      SUBS,
      { update: [], remove: [] },
      { update: [sub({ rid: 'r1', name: 'newroom' })], remove: [] },
    );
    const dir = new RoomDirectory(db, rc as never);
    await dir.refresh(); // consumes the empty first response
    const room = await dir.resolve('newroom');
    expect(room.rid).toBe('r1');
    expect(rc.countOf(SUBS)).toBe(2);
  });

  it('throws a helpful not-found error after a refresh still misses', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.on(SUBS, { update: [], remove: [] });
    const dir = new RoomDirectory(db, rc as never);
    await dir.refresh();
    await expect(dir.resolve('ghost')).rejects.toThrow(
      /not found — use list_rooms\/rooms command/,
    );
  });
});

describe('RoomDirectory.refresh / ensureFresh / list', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('records rooms_refreshed_at and upserts rooms', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.on(SUBS, { update: [sub({ rid: 'r1', name: 'general' })], remove: [] });
    const dir = new RoomDirectory(db, rc as never);
    await dir.refresh();
    expect(db.getMeta('rooms_refreshed_at')).toBeDefined();
    expect(db.getRoom('r1')?.name).toBe('general');
  });

  it('ensureFresh skips the network when within TTL', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.on(SUBS, { update: [sub({ rid: 'r1' })], remove: [] });
    const dir = new RoomDirectory(db, rc as never);
    await dir.refresh();
    await dir.ensureFresh();
    await dir.list();
    expect(rc.countOf(SUBS)).toBe(1);
  });

  it('list returns filtered rooms', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.on(SUBS, {
      update: [
        sub({ rid: 'c1', name: 'general', t: 'c' }),
        sub({ rid: 'p1', name: 'secret', t: 'p' }),
      ],
      remove: [],
    });
    const dir = new RoomDirectory(db, rc as never);
    await dir.refresh();
    const groups = await dir.list({ type: 'p' });
    expect(groups.map((r) => r.rid)).toEqual(['p1']);
  });
});
