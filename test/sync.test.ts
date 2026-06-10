import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { SyncEngine } from '../src/core/sync.js';
import { RcApiError } from '../src/core/errors.js';
import type { RcMessage } from '../src/core/normalize.js';
import type {
  RcClient,
  HistoryResult,
  SyncMessagesResult,
  ThreadMessagesResult,
  GetMessageResult,
} from '../src/core/rc-client.js';
import type { RoomRow } from '../src/core/types.js';

/** Typed-method surface the SyncEngine consumes from RcClient. */
type SyncMethods = Pick<
  RcClient,
  'getHistory' | 'syncMessages' | 'getThreadMessages' | 'getMessage'
>;

/**
 * Fake RcClient: each typed method maps to a handler that receives the call
 * params and returns a response. Records every call (keyed by method name) for
 * assertions. `historyRoomType` is folded into the recorded params so the
 * existing history scenarios still assert on `latest` / `oldest`.
 */
type Handler = (params: Record<string, unknown>, n: number) => unknown;

class FakeRc {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  private handlers = new Map<string, Handler>();
  private perMethodCount = new Map<string, number>();

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`FakeRc: no handler for ${method}`);
    const n = this.perMethodCount.get(method) ?? 0;
    this.perMethodCount.set(method, n + 1);
    return handler(params, n);
  }

  getHistory(
    roomType: 'c' | 'p' | 'd',
    params: Record<string, unknown>,
  ): Promise<HistoryResult> {
    return Promise.resolve(
      this.dispatch('getHistory', { roomType, ...params }) as HistoryResult,
    );
  }

  syncMessages(params: Record<string, unknown>): Promise<SyncMessagesResult> {
    return Promise.resolve(
      this.dispatch('syncMessages', params) as SyncMessagesResult,
    );
  }

  getThreadMessages(
    params: Record<string, unknown>,
  ): Promise<ThreadMessagesResult> {
    return Promise.resolve(
      this.dispatch('getThreadMessages', params) as ThreadMessagesResult,
    );
  }

  getMessage(params: Record<string, unknown>): Promise<GetMessageResult> {
    return Promise.resolve(
      this.dispatch('getMessage', params) as GetMessageResult,
    );
  }

  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  total(): number {
    return this.calls.length;
  }
}

// Compile-time guard: the fake must structurally satisfy the methods it stubs.
const _typecheck: SyncMethods = new FakeRc();
void _typecheck;

/** A directory stub: refresh() inserts a room so missing-room paths work. */
function fakeRooms(db: Db, room?: RoomRow): { refresh(): Promise<void> } {
  return {
    async refresh() {
      if (room) db.upsertRoom(room);
    },
  };
}

function room(rid: string, over: Partial<RoomRow> = {}): RoomRow {
  return {
    rid,
    name: rid,
    fname: rid,
    t: 'c',
    unread: 0,
    last_synced_at: null,
    oldest_loaded_ts: null,
    fully_backfilled: 0,
    sub_updated_at: null,
    ...over,
  };
}

/** Build a synthetic RC message at a given epoch second offset from a base. */
function rcMsg(id: string, tsMs: number, over: Partial<RcMessage> = {}): RcMessage {
  return {
    _id: id,
    rid: 'r1',
    msg: `msg ${id}`,
    ts: new Date(tsMs).toISOString(),
    u: { _id: 'u1', username: 'alice', name: 'Alice' },
    ...over,
  };
}

const HIST = 'getHistory';
const SYNC = 'syncMessages';
const THREAD = 'getThreadMessages';

function makeEngine(
  db: Db,
  rc: FakeRc,
  rooms: { refresh(): Promise<void> },
  opts?: Partial<{ ttlSeconds: number; backfillLimit: number; backfillDays: number }>,
): SyncEngine {
  return new SyncEngine(db, rc as unknown as RcClient, rooms, {
    ttlSeconds: opts?.ttlSeconds ?? 60,
    backfillLimit: opts?.backfillLimit ?? 500,
    backfillDays: opts?.backfillDays ?? 30,
  });
}

describe('SyncEngine backfill', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('pages history backwards, sets watermark/horizon, marks fully_backfilled on short page', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');

    const rc = new FakeRc().on(HIST, (_params, n) => {
      if (n === 0) {
        // Page 1: 100 messages (full page) descending from base.
        const messages = Array.from({ length: 100 }, (_, i) =>
          rcMsg(`p1-${i}`, base - i * 1000),
        );
        return { messages };
      }
      // Page 2: 30 messages (short page → exhausted), older still.
      const messages = Array.from({ length: 30 }, (_, i) =>
        rcMsg(`p2-${i}`, base - (100 + i) * 1000),
      );
      return { messages };
    });

    const before = new Date().toISOString();
    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.ensureRoomSynced('r1');

    const count = (db.conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(count).toBe(130);

    const r = db.getRoom('r1')!;
    expect(r.fully_backfilled).toBe(1);
    // oldest_loaded_ts is the minimum ts seen (page 2, last message).
    expect(r.oldest_loaded_ts).toBe(new Date(base - 129 * 1000).toISOString());
    // last_synced_at watermark was taken BEFORE any fetch.
    expect(r.last_synced_at).toBeDefined();
    expect(r.last_synced_at! >= before).toBe(true);
    expect(rc.countOf(HIST)).toBe(2);
  });

  it('stops at backfillLimit when the room is deeper than the cap', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    // Always returns full pages → would page forever without the cap.
    let serial = 0;
    const rc = new FakeRc().on(HIST, () => {
      const messages = Array.from({ length: 100 }, () => {
        const id = `m${serial}`;
        const m = rcMsg(id, base - serial * 1000);
        serial++;
        return m;
      });
      return { messages };
    });

    const engine = makeEngine(db, rc, fakeRooms(db), { backfillLimit: 150 });
    await engine.ensureRoomSynced('r1');

    // 100 (page1, total=100 < 150 → continue) + 100 (page2, total=200 ≥ 150 → stop).
    expect(rc.countOf(HIST)).toBe(2);
    expect(db.getRoom('r1')!.fully_backfilled).toBe(0);
  });
});

describe('SyncEngine ensureRoomSyncedShallow', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('never-synced room: ONE history call with oldest=sinceTs, shallow sync state', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    const sinceTs = new Date(base - 60 * 60 * 1000).toISOString();

    const rc = new FakeRc().on(HIST, (params) => {
      // Triage window: oldest pinned to the watermark, count 100, threads on.
      expect(params['oldest']).toBe(sinceTs);
      expect(params['count']).toBe(100);
      expect(params['showThreadMessages']).toBe(true);
      // No `latest` on the first page.
      expect(params['latest']).toBeUndefined();
      // Short page → window fully loaded in one call.
      const messages = Array.from({ length: 5 }, (_, i) =>
        rcMsg(`u${i}`, base - i * 1000),
      );
      return { messages };
    });

    const before = new Date().toISOString();
    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.ensureRoomSyncedShallow('r1', sinceTs);

    expect(rc.countOf(HIST)).toBe(1);
    const count = (db.conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(count).toBe(5);

    const r = db.getRoom('r1')!;
    // Watermark before the fetch; horizon at sinceTs; not fully backfilled.
    expect(r.last_synced_at).toBeDefined();
    expect(r.last_synced_at! >= before).toBe(true);
    expect(r.oldest_loaded_ts).toBe(sinceTs);
    expect(r.fully_backfilled).toBe(0);
  });

  it('already-synced room: delegates to delta (one syncMessages, zero history)', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: '2026-06-10T10:00:00.000Z' }));
    const base = Date.parse('2026-06-10T11:00:00.000Z');

    const rc = new FakeRc()
      .on(SYNC, () => ({
        result: { updated: [rcMsg('d1', base)], deleted: [], cursor: { next: null, previous: null } },
      }))
      .on(HIST, () => {
        throw new Error('history must not be called for an already-synced shallow sync');
      });

    // TTL 0 → stale → delta path.
    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });
    await engine.ensureRoomSyncedShallow('r1', '2026-06-10T09:00:00.000Z');

    expect(rc.countOf(SYNC)).toBe(1);
    expect(rc.countOf(HIST)).toBe(0);
    expect(db.getMessage('d1')).toBeDefined();
  });

  it('burst paging: full pages page backwards until a short page (100 + 100 + 30)', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    const sinceTs = new Date(base - 24 * 60 * 60 * 1000).toISOString();

    const rc = new FakeRc().on(HIST, (params, n) => {
      // Every page keeps `oldest` pinned to the watermark.
      expect(params['oldest']).toBe(sinceTs);
      if (n === 0) {
        expect(params['latest']).toBeUndefined();
        return { messages: Array.from({ length: 100 }, (_, i) => rcMsg(`p1-${i}`, base - i * 1000)) };
      }
      if (n === 1) {
        // Second page must page backwards from the oldest of page 1.
        expect(params['latest']).toBe(new Date(base - 99 * 1000 - 1).toISOString());
        return { messages: Array.from({ length: 100 }, (_, i) => rcMsg(`p2-${i}`, base - (100 + i) * 1000)) };
      }
      // Third page: short → stop.
      return { messages: Array.from({ length: 30 }, (_, i) => rcMsg(`p3-${i}`, base - (200 + i) * 1000)) };
    });

    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.ensureRoomSyncedShallow('r1', sinceTs);

    expect(rc.countOf(HIST)).toBe(3);
    const count = (db.conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(count).toBe(230);
    expect(db.getRoom('r1')!.oldest_loaded_ts).toBe(sinceTs);
  });

  it('caps at MAX_SHALLOW_PAGES (3) and stores a partial burst when full pages persist', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    const sinceTs = new Date(base - 24 * 60 * 60 * 1000).toISOString();
    // Always returns full pages → would page forever without the cap.
    let serial = 0;
    const rc = new FakeRc().on(HIST, () => {
      const messages = Array.from({ length: 100 }, () => {
        const m = rcMsg(`m${serial}`, base - serial * 1000);
        serial++;
        return m;
      });
      return { messages };
    });

    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.ensureRoomSyncedShallow('r1', sinceTs);

    // Capped at 3 pages; partial (300 stored), still shallow state.
    expect(rc.countOf(HIST)).toBe(3);
    const count = (db.conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(count).toBe(300);
    const r = db.getRoom('r1')!;
    expect(r.fully_backfilled).toBe(0);
    expect(r.oldest_loaded_ts).toBe(sinceTs);
  });

  it('after a shallow sync, a read older than sinceTs deepens via extendBackfill', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    const sinceTs = new Date(base - 60 * 60 * 1000).toISOString();

    let phase: 'shallow' | 'extend' = 'shallow';
    const rc = new FakeRc().on(HIST, (params) => {
      if (phase === 'shallow') {
        expect(params['oldest']).toBe(sinceTs);
        // Window covered in one short page.
        return { messages: [rcMsg('u0', base - 1000)] };
      }
      // extendBackfill: no `oldest`, pages backwards from the horizon (sinceTs).
      expect(params['oldest']).toBeUndefined();
      expect(params['latest']).toBe(sinceTs);
      const sinceMs = Date.parse(sinceTs);
      return { messages: Array.from({ length: 10 }, (_, i) => rcMsg(`o${i}`, sinceMs - (i + 1) * 1000)) };
    });

    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.ensureRoomSyncedShallow('r1', sinceTs);
    expect(rc.countOf(HIST)).toBe(1);
    expect(db.getRoom('r1')!.oldest_loaded_ts).toBe(sinceTs);

    // Now a timeline read wants history older than sinceTs → extendBackfill
    // fires (oldest_loaded_ts=sinceTs, fully_backfilled=0 make it eligible).
    phase = 'extend';
    const target = new Date(Date.parse(sinceTs) - 5 * 1000).toISOString();
    await engine.extendBackfill('r1', target);

    expect(rc.countOf(HIST)).toBe(2);
    expect(db.getMessage('o0')).toBeDefined();
    const r = db.getRoom('r1')!;
    expect(r.oldest_loaded_ts! < sinceTs).toBe(true);
  });
});

describe('SyncEngine missing room', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('refreshes the directory when the room is unknown, then backfills', async () => {
    db = openDb(':memory:');
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    const rc = new FakeRc().on(HIST, () => ({ messages: [rcMsg('m1', base)] }));
    const engine = makeEngine(db, rc, fakeRooms(db, room('r1')));
    await engine.ensureRoomSynced('r1');
    expect(db.getMessage('m1')).toBeDefined();
  });

  it('throws when the room is still missing after a refresh', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db) /* refresh inserts nothing */);
    await expect(engine.ensureRoomSynced('ghost')).rejects.toThrow(/not found after refreshing/);
  });
});

describe('SyncEngine delta', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('runs exactly one syncMessages call, applies edits + deletions, then no-ops while fresh', async () => {
    db = openDb(':memory:');
    const synced = '2026-06-10T10:00:00.000Z';
    db.upsertRoom(room('r1', { last_synced_at: synced }));
    // Seed a message that the delta will "edit" and one it will delete.
    db.upsertMessages([
      { id: 'orig', rid: 'r1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'old text', ts: '2026-06-10T09:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'doomed', rid: 'r1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'bye', ts: '2026-06-10T09:30:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const base = Date.parse('2026-06-10T11:00:00.000Z');
    const rc = new FakeRc().on(SYNC, () => ({
      result: {
        updated: [
          rcMsg('orig', base, { msg: 'new text', editedAt: new Date(base).toISOString() }),
          rcMsg('fresh', base + 1000),
        ],
        deleted: [{ _id: 'doomed' }],
        cursor: { next: null, previous: null },
      },
    }));

    // TTL 0 → always stale.
    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });
    await engine.ensureRoomSynced('r1');

    expect(rc.countOf(SYNC)).toBe(1);
    expect(db.getMessage('orig')?.text).toBe('new text');
    expect(db.getMessage('fresh')).toBeDefined();
    expect(db.getMessage('doomed')?.deleted).toBe(1);

    // Make it fresh again, then re-call: zero network.
    const callsBefore = rc.total();
    const engineFresh = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 3600 });
    await engineFresh.ensureRoomSynced('r1');
    expect(rc.total()).toBe(callsBefore);
  });

  it('paginates syncMessages when a full page has a next cursor', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: '2026-06-10T10:00:00.000Z' }));
    const base = Date.parse('2026-06-10T11:00:00.000Z');

    const rc = new FakeRc().on(SYNC, (params, n) => {
      if (n === 0) {
        expect(params['next']).toBeUndefined();
        const updated = Array.from({ length: 100 }, (_, i) => rcMsg(`a${i}`, base + i * 1000));
        return { result: { updated, deleted: [], cursor: { next: 'CURSOR2', previous: null } } };
      }
      // Second page: must carry the cursor.
      expect(params['next']).toBe('CURSOR2');
      return { result: { updated: [rcMsg('b0', base + 200000)], deleted: [], cursor: { next: null, previous: null } } };
    });

    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });
    await engine.ensureRoomSynced('r1');
    expect(rc.countOf(SYNC)).toBe(2);
    expect(db.getMessage('b0')).toBeDefined();
  });

  it('re-backfills (no syncMessages) when last_synced_at predates the backfill window', async () => {
    db = openDb(':memory:');
    // 31 days stale → older than the 30-day backfill window → guard fires.
    const stale = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRoom(room('r1', { last_synced_at: stale }));
    const base = Date.now();

    const rc = new FakeRc()
      .on(SYNC, () => {
        throw new Error('syncMessages must not be called for a window-stale room');
      })
      .on(HIST, () => ({
        // Short page → exhausted → backfill completes and sets watermarks.
        messages: [rcMsg('h1', base)],
      }));

    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0, backfillDays: 30 });
    await engine.ensureRoomSynced('r1');

    expect(rc.countOf(SYNC)).toBe(0);
    expect(rc.countOf(HIST)).toBe(1);
    expect(db.getMessage('h1')).toBeDefined();
    const r = db.getRoom('r1')!;
    // Watermark advanced past the stale value; backfill state recorded.
    expect(r.last_synced_at! > stale).toBe(true);
    expect(r.fully_backfilled).toBe(1);
    expect(r.oldest_loaded_ts).toBe(new Date(base).toISOString());
  });

  it('runs the normal delta path when last_synced_at is within the backfill window', async () => {
    db = openDb(':memory:');
    // 29 days stale → still inside the 30-day window → delta path.
    const stale = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertRoom(room('r1', { last_synced_at: stale }));
    const base = Date.now();

    const rc = new FakeRc()
      .on(SYNC, () => ({
        result: { updated: [rcMsg('d1', base)], deleted: [], cursor: { next: null, previous: null } },
      }))
      .on(HIST, () => {
        throw new Error('history must not be called on the in-window delta path');
      });

    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0, backfillDays: 30 });
    await engine.ensureRoomSynced('r1');

    expect(rc.countOf(SYNC)).toBe(1);
    expect(rc.countOf(HIST)).toBe(0);
    expect(db.getMessage('d1')).toBeDefined();
  });

  it('falls back to history when syncMessages rejects with 400', async () => {
    db = openDb(':memory:');
    const synced = '2026-06-10T10:00:00.000Z';
    db.upsertRoom(room('r1', { last_synced_at: synced }));
    const base = Date.parse('2026-06-10T11:00:00.000Z');

    const rc = new FakeRc()
      .on(SYNC, () => {
        throw new RcApiError('endpoint disabled', 400);
      })
      .on(HIST, (params) => {
        // Fallback must pass the watermark as `oldest`.
        expect(params['oldest']).toBe(synced);
        return { messages: [rcMsg('h1', base)] };
      });

    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });
    await engine.ensureRoomSynced('r1');

    expect(rc.countOf(SYNC)).toBe(1);
    expect(rc.countOf(HIST)).toBe(1);
    expect(db.getMessage('h1')).toBeDefined();
    // Watermark still advanced.
    expect(db.getRoom('r1')!.last_synced_at! > synced).toBe(true);
  });
});

describe('SyncEngine per-room mutex', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('coalesces concurrent ensureRoomSynced(same rid) into one backfill', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');

    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => (resolveGate = r));
    const rc = new FakeRc().on(HIST, async () => {
      await gate; // hold the first (and only) backfill in flight
      return { messages: [rcMsg('m1', base)] };
    });

    const engine = makeEngine(db, rc, fakeRooms(db));
    const p1 = engine.ensureRoomSynced('r1');
    const p2 = engine.ensureRoomSynced('r1');
    resolveGate();
    await Promise.all([p1, p2]);

    // One coalesced backfill → exactly one history call.
    expect(rc.countOf(HIST)).toBe(1);
  });
});

describe('SyncEngine ensureThreadLoaded', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('fetches thread messages when tcount exceeds local replies, then self-heals', async () => {
    db = openDb(':memory:');
    // Room is fresh so the inner ensureRoomSynced is a no-op (long TTL).
    db.upsertRoom(room('r1', { last_synced_at: new Date().toISOString() }));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    // Parent with tcount=5; locally we only have 2 replies.
    db.upsertMessages([
      { id: 'tp', rid: 'r1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent', ts: new Date(base).toISOString(), tmid: null, tcount: 5, tlm: new Date(base + 5000).toISOString(), edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'rA', rid: 'r1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'r1', ts: new Date(base + 1000).toISOString(), tmid: 'tp', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'rB', rid: 'r1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'r2', ts: new Date(base + 2000).toISOString(), tmid: 'tp', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const rc = new FakeRc().on(THREAD, () => ({
      total: 5,
      messages: [
        rcMsg('rA', base + 1000, { tmid: 'tp' }),
        rcMsg('rB', base + 2000, { tmid: 'tp' }),
        rcMsg('rC', base + 3000, { tmid: 'tp' }),
        rcMsg('rD', base + 4000, { tmid: 'tp' }),
        rcMsg('rE', base + 5000, { tmid: 'tp' }),
      ],
    }));

    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 3600 });
    const parent = await engine.ensureThreadLoaded('tp');

    expect(parent.id).toBe('tp');
    expect(rc.countOf(THREAD)).toBe(1);
    expect(db.countThreadReplies('tp')).toBe(5);
    expect(db.getThreadSync('tp')?.fully_loaded).toBe(1);

    // Re-call: tcount(5) == local(5) AND sync row exists → no thread fetch.
    await engine.ensureThreadLoaded('tp');
    expect(rc.countOf(THREAD)).toBe(1);
  });
});

describe('SyncEngine extendBackfill', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('no-ops when the room is already fully backfilled', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { fully_backfilled: 1, oldest_loaded_ts: '2026-06-01T00:00:00.000Z' }));
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.extendBackfill('r1', '2025-01-01T00:00:00.000Z');
    expect(rc.total()).toBe(0);
  });

  it('no-ops when the requested point is within the loaded window', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { oldest_loaded_ts: '2026-06-01T00:00:00.000Z' }));
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db));
    // beforeTs newer than oldest_loaded_ts → already covered.
    await engine.extendBackfill('r1', '2026-06-05T00:00:00.000Z');
    expect(rc.total()).toBe(0);
  });

  it('extends backwards and advances oldest_loaded_ts to cover the request', async () => {
    db = openDb(':memory:');
    const oldest = '2026-06-10T12:00:00.000Z';
    db.upsertRoom(room('r1', { oldest_loaded_ts: oldest }));
    const oldestMs = Date.parse(oldest);
    const target = new Date(oldestMs - 50 * 1000).toISOString();

    const rc = new FakeRc().on(HIST, (params) => {
      // First (and only) extend page: latest must start at the current horizon.
      expect(params['latest']).toBe(oldest);
      // Return 60 messages older than the horizon (short page → exhausted),
      // reaching past the target.
      const messages = Array.from({ length: 60 }, (_, i) =>
        rcMsg(`old${i}`, oldestMs - (i + 1) * 1000),
      );
      return { messages };
    });

    const engine = makeEngine(db, rc, fakeRooms(db));
    await engine.extendBackfill('r1', target);

    expect(rc.countOf(HIST)).toBe(1);
    const r = db.getRoom('r1')!;
    expect(r.oldest_loaded_ts).toBe(new Date(oldestMs - 60 * 1000).toISOString());
    // The page reached the requested point, so the loop stops on target
    // coverage (not on exhaustion) → fully_backfilled stays 0.
    expect(r.oldest_loaded_ts! <= target).toBe(true);
  });
});

describe('SyncEngine stale-while-revalidate (ensureRoomSyncedSWR)', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('warm-stale room serves INSTANTLY (does not await the delta) and kicks it in the background', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: '2026-06-10T10:00:00.000Z' }));

    // The delta NEVER resolves. If the read awaited it, this test would hang.
    let deltaStarted = false;
    let releaseDelta: () => void = () => {};
    const deltaHeld = new Promise<void>((r) => (releaseDelta = r));
    const rc = new FakeRc().on(SYNC, async () => {
      deltaStarted = true;
      await deltaHeld; // hang forever (until we release in cleanup)
      return { result: { updated: [], deleted: [], cursor: { next: null, previous: null } } };
    });

    // TTL 0 → stale. SWR must return promptly with refreshing: true.
    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });
    const outcome = await engine.ensureRoomSyncedSWR('r1');

    expect(outcome.refreshing).toBe(true);
    // The background delta was kicked (its handler began running) but the read
    // returned without awaiting it.
    await Promise.resolve();
    expect(deltaStarted).toBe(true);
    releaseDelta(); // let the dangling promise settle so the test exits cleanly
  });

  it('warm-FRESH room is a no-op: refreshing false, zero network', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: new Date().toISOString() }));
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 3600 });
    const outcome = await engine.ensureRoomSyncedSWR('r1');
    expect(outcome.refreshing).toBe(false);
    expect(rc.total()).toBe(0);
  });

  it('totally-cold room BLOCKS for one history page only, then background-deepens', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1')); // never synced, no local data
    const base = Date.parse('2026-06-10T12:00:00.000Z');

    // Gate every history call after the first so the background deepen cannot
    // outrun the assertions: the first page resolves immediately, later pages
    // block on `gate` (which we release at the end). Always full pages → without
    // the one-page block this would page forever.
    let serial = 0;
    let callsAtUnblock = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseGate = r));
    const rc = new FakeRc().on(HIST, async (_params, n) => {
      if (n >= 1) {
        // A background page started — record and hold it.
        callsAtUnblock++;
        await gate;
      }
      const messages = Array.from({ length: 100 }, () => {
        const m = rcMsg(`m${serial}`, base - serial * 1000);
        serial++;
        return m;
      });
      return { messages };
    });

    const engine = makeEngine(db, rc, fakeRooms(db), { backfillLimit: 500 });
    const outcome = await engine.ensureRoomSyncedSWR('r1');

    // The AWAITED (blocking) work was exactly one page: 100 messages persisted
    // before SWR returned, room not yet fully backfilled, refreshing flagged.
    expect(
      (db.conn.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
    ).toBe(100);
    expect(outcome.refreshing).toBe(true);
    expect(db.getRoom('r1')!.fully_backfilled).toBe(0);

    // Let the background deepen proceed; it continues paging past page 1.
    releaseGate();
    await new Promise((r) => setTimeout(r, 0));
    expect(callsAtUnblock).toBeGreaterThanOrEqual(1);
    expect(rc.countOf(HIST)).toBeGreaterThan(1);
  });

  it('blocking ensureRoomSynced still awaits fully and reports refreshing false', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: '2026-06-10T10:00:00.000Z' }));
    const base = Date.parse('2026-06-10T11:00:00.000Z');
    const rc = new FakeRc().on(SYNC, () => ({
      result: { updated: [rcMsg('d1', base)], deleted: [], cursor: { next: null, previous: null } },
    }));
    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });
    const outcome = await engine.ensureRoomSynced('r1');
    expect(outcome.refreshing).toBe(false);
    expect(db.getMessage('d1')).toBeDefined();
  });

  it('does not stack a second background sync while one is in flight (mutex dedupe)', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: '2026-06-10T10:00:00.000Z' }));
    let releaseDelta: () => void = () => {};
    const held = new Promise<void>((r) => (releaseDelta = r));
    const rc = new FakeRc().on(SYNC, async () => {
      await held;
      return { result: { updated: [], deleted: [], cursor: { next: null, previous: null } } };
    });
    const engine = makeEngine(db, rc, fakeRooms(db), { ttlSeconds: 0 });

    // Two back-to-back SWR reads while stale: the first kicks the delta, the
    // second must coalesce onto the in-flight one (no second syncMessages).
    await engine.ensureRoomSyncedSWR('r1');
    await engine.ensureRoomSyncedSWR('r1');
    await Promise.resolve();
    expect(rc.countOf(SYNC)).toBe(1);
    releaseDelta();
  });
});

describe('SyncEngine intent-driven depth (deepenRoom / pickStaleUnreadRoom)', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('deepenRoom backfills a never-synced room and reports messagesLoaded', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    const base = Date.parse('2026-06-10T12:00:00.000Z');
    const rc = new FakeRc().on(HIST, (_params, n) => {
      if (n === 0) {
        return { messages: Array.from({ length: 100 }, (_, i) => rcMsg(`p1-${i}`, base - i * 1000)) };
      }
      return { messages: Array.from({ length: 20 }, (_, i) => rcMsg(`p2-${i}`, base - (100 + i) * 1000)) };
    });
    const engine = makeEngine(db, rc, fakeRooms(db), { backfillLimit: 500 });
    const res = await engine.deepenRoom('r1');
    expect(res.messagesLoaded).toBe(120);
    expect(res.fullyBackfilled).toBe(true);
    expect(db.getRoom('r1')!.fully_backfilled).toBe(1);
  });

  it('deepenRoom on a shallow room pages backwards via extendBackfill', async () => {
    db = openDb(':memory:');
    // Shallow: synced + horizon set, not fully backfilled (the shallow-sync state).
    const oldest = '2026-06-10T12:00:00.000Z';
    db.upsertRoom(room('r1', { last_synced_at: oldest, oldest_loaded_ts: oldest }));
    const oldestMs = Date.parse(oldest);
    const rc = new FakeRc().on(HIST, (params) => {
      expect(params['latest']).toBe(oldest); // starts at the horizon
      return { messages: Array.from({ length: 30 }, (_, i) => rcMsg(`old${i}`, oldestMs - (i + 1) * 1000)) };
    });
    const engine = makeEngine(db, rc, fakeRooms(db));
    const res = await engine.deepenRoom('r1');
    expect(res.messagesLoaded).toBe(30);
    // Short page → exhausted → fully backfilled.
    expect(res.fullyBackfilled).toBe(true);
  });

  it('deepenRoom is a no-op on an already fully-backfilled room', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1', { last_synced_at: '2026-06-10T10:00:00.000Z', fully_backfilled: 1, oldest_loaded_ts: '2026-06-01T00:00:00.000Z' }));
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db));
    const res = await engine.deepenRoom('r1');
    expect(res.messagesLoaded).toBe(0);
    expect(res.fullyBackfilled).toBe(true);
    expect(rc.total()).toBe(0);
  });

  it('pickStaleUnreadRoom picks the never-synced unread room over a synced one', async () => {
    db = openDb(':memory:');
    // C1: unread, never synced (last_synced_at null) → highest priority.
    db.upsertRoom(room('C1', { unread: 3 }));
    // C2: unread but recently synced (still partial).
    db.upsertRoom(room('C2', { unread: 1, last_synced_at: new Date().toISOString() }));
    // C3: fully backfilled → excluded.
    db.upsertRoom(room('C3', { unread: 5, last_synced_at: new Date().toISOString(), fully_backfilled: 1 }));
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db));
    expect(engine.pickStaleUnreadRoom()).toBe('C1');
  });

  it('pickStaleUnreadRoom returns null when nothing qualifies', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('C1', { unread: 0, alert: 0, tunread: '[]' }));
    const rc = new FakeRc();
    const engine = makeEngine(db, rc, fakeRooms(db));
    expect(engine.pickStaleUnreadRoom()).toBeNull();
  });
});
