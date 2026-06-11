import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../src/core/app.js';
import { openDb, type Db, type MessageRow, type RoomRow } from '../src/core/db.js';
import { WatchService } from '../src/core/watch.js';

// ---- fixtures --------------------------------------------------------------

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

function msg(id: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    rid: 'r1',
    author_id: 'u1',
    author_username: 'alice',
    author_name: 'Alice',
    text: 'hello',
    ts: '2026-06-10T00:00:00.000Z',
    tmid: null,
    tcount: null,
    tlm: null,
    edited_at: null,
    system_type: null,
    attachments_json: null,
    deleted: 0,
    updated_at: null,
    ...over,
  };
}

/** Spy SyncEngine surface: records ensureRoomSynced(rid, opts) calls. */
function spySync(): {
  ensureRoomSynced: ReturnType<typeof vi.fn>;
  calls: Array<{ rid: string; force: boolean }>;
} {
  const calls: Array<{ rid: string; force: boolean }> = [];
  const ensureRoomSynced = vi.fn(
    async (rid: string, opts?: { force?: boolean }): Promise<void> => {
      calls.push({ rid, force: opts?.force === true });
    },
  );
  return { ensureRoomSynced, calls };
}

/** Records postMessage calls; returns a wire message so sendMessage works. */
function fakeRc(): {
  posts: Array<Record<string, unknown>>;
  postMessage: ReturnType<typeof vi.fn>;
} {
  const posts: Array<Record<string, unknown>> = [];
  const postMessage = vi.fn(async (body: Record<string, unknown>) => {
    posts.push(body);
    return {
      message: {
        _id: `posted-${posts.length}`,
        rid: 'note',
        msg: body['text'],
        ts: '2026-06-10T00:00:00.000Z',
        u: { _id: 'me', username: 'me' },
      },
    };
  });
  return { posts, postMessage };
}

/**
 * Hand-built App: real :memory: Db, stubbed rooms (list/resolve from cache),
 * spy sync, fake rc for postMessage. Only the surface WatchService touches is
 * populated; everything else is a throwing stub to catch unexpected use.
 */
function makeApp(
  db: Db,
  sync: { ensureRoomSynced: ReturnType<typeof vi.fn> },
  rc: { postMessage: ReturnType<typeof vi.fn> },
): App {
  const rooms = {
    async list(): Promise<RoomRow[]> {
      return db.findRooms();
    },
    async resolve(input: string): Promise<RoomRow> {
      const r = db.getRoom(input) ?? db.findRooms().find((x) => x.name === input);
      if (!r) throw new Error(`Room "${input}" not found`);
      return r;
    },
  };
  return {
    config: {
      url: 'http://example.com',
      token: 'tok',
      userId: 'uid',
      dbPath: ':memory:',
      ttlSeconds: 60,
      backfillLimit: 100,
      emojiImages: false,
      readOnly: false,
    },
    db,
    rc: rc as never,
    rooms: rooms as never,
    emojis: {} as never,
    sync: sync as never,
    search: {} as never,
  };
}

// ---- WatchService.runOnce --------------------------------------------------

describe('WatchService.runOnce', () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  it('returns only messages after sinceTs; advances nextSinceTs to the max ts', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('old', { text: 'incident alpha', ts: '2026-06-10T00:00:00.000Z' }),
      msg('new1', { text: 'incident beta', ts: '2026-06-10T01:00:00.000Z' }),
      msg('new2', { text: 'incident gamma', ts: '2026-06-10T02:00:00.000Z' }),
    ]);

    const sync = spySync();
    const app = makeApp(db, sync, fakeRc());
    const res = await new WatchService(app).runOnce({
      query: 'incident',
      sinceTs: '2026-06-10T00:30:00.000Z',
    });

    expect(res.matches.map((m) => m.id)).toEqual(['new1', 'new2']);
    expect(res.nextSinceTs).toBe('2026-06-10T02:00:00.000Z');
    // Oldest-first ordering.
    expect(res.matches[0]!.id).toBe('new1');
    // Each match carries its room name.
    expect(res.matches[0]!.roomName).toBe('r1');
  });

  it('leaves sinceTs unchanged when there are no matches', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('old', { text: 'incident', ts: '2026-06-10T00:00:00.000Z' })]);

    const sync = spySync();
    const app = makeApp(db, sync, fakeRc());
    const since = '2026-06-10T05:00:00.000Z';
    const res = await new WatchService(app).runOnce({ query: 'incident', sinceTs: since });

    expect(res.matches).toEqual([]);
    expect(res.nextSinceTs).toBe(since);
  });

  it('room filter narrows to that room and force-syncs only it', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertRoom(room('r2'));
    db.upsertMessages([
      msg('a', { rid: 'r1', text: 'shared token', ts: '2026-06-10T01:00:00.000Z' }),
      msg('b', { rid: 'r2', text: 'shared token', ts: '2026-06-10T01:00:00.000Z' }),
    ]);

    const sync = spySync();
    const app = makeApp(db, sync, fakeRc());
    const res = await new WatchService(app).runOnce({
      query: 'shared',
      room: 'r1',
      sinceTs: '2026-06-10T00:00:00.000Z',
    });

    expect(res.matches.map((m) => m.id)).toEqual(['a']);
    expect(sync.calls).toEqual([{ rid: 'r1', force: true }]);
  });

  it('with no room: syncs every room with force=true', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertRoom(room('r2'));
    db.upsertRoom(room('r3'));
    db.upsertMessages([msg('a', { rid: 'r2', text: 'ping', ts: '2026-06-10T01:00:00.000Z' })]);

    const sync = spySync();
    const app = makeApp(db, sync, fakeRc());
    const res = await new WatchService(app).runOnce({
      query: 'ping',
      sinceTs: '2026-06-10T00:00:00.000Z',
    });

    expect(res.matches.map((m) => m.id)).toEqual(['a']);
    expect(sync.calls.map((c) => c.rid).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(sync.calls.every((c) => c.force)).toBe(true);
  });
});

// ---- WatchService.watch (loop) ---------------------------------------------

describe('WatchService.watch', () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  it('aborts promptly mid-sleep via AbortSignal', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));

    const sync = spySync();
    const app = makeApp(db, sync, fakeRc());
    const controller = new AbortController();

    const start = Date.now();
    const p = new WatchService(app).watch({
      query: 'incident',
      // Floored to 15s — if abort were ignored the test would hang for 15s.
      intervalSeconds: 15,
      signal: controller.signal,
      sinceTs: '2026-06-10T00:00:00.000Z',
      onMatch: () => {},
    });

    // Let the first (empty) tick run, then abort during the sleep.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await p;

    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('notifyTarget posts each match via rc.postMessage', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertRoom(room('note'));
    db.upsertMessages([
      msg('m1', { text: 'incident here', ts: '2026-06-10T01:00:00.000Z' }),
    ]);

    const sync = spySync();
    const rc = fakeRc();
    const app = makeApp(db, sync, rc);
    const controller = new AbortController();

    const matches: string[] = [];
    const p = new WatchService(app).watch({
      query: 'incident',
      intervalSeconds: 15,
      notifyTarget: 'note',
      signal: controller.signal,
      sinceTs: '2026-06-10T00:00:00.000Z',
      onMatch: (m) => matches.push(m.id),
    });

    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    await p;

    expect(matches).toEqual(['m1']);
    expect(rc.posts).toHaveLength(1);
    expect(String(rc.posts[0]!['text'])).toContain('[watch:incident]');
    expect(String(rc.posts[0]!['text'])).toContain('@alice');
    expect(String(rc.posts[0]!['text'])).toContain('incident here');
  });

  it('logPath gets valid JSON lines', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('m1', { text: 'incident one', ts: '2026-06-10T01:00:00.000Z' }),
      msg('m2', { text: 'incident two', ts: '2026-06-10T02:00:00.000Z' }),
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'watch-test-'));
    const logPath = join(dir, 'nested', 'watch.log');

    const sync = spySync();
    const app = makeApp(db, sync, fakeRc());
    const controller = new AbortController();

    try {
      const p = new WatchService(app).watch({
        query: 'incident',
        room: 'r1',
        intervalSeconds: 15,
        logPath,
        signal: controller.signal,
        sinceTs: '2026-06-10T00:00:00.000Z',
        onMatch: () => {},
      });

      await new Promise((r) => setTimeout(r, 30));
      controller.abort();
      await p;

      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!);
      expect(first.event).toBe('match');
      expect(first.query).toBe('incident');
      expect(first.room).toBe('r1');
      expect(first.msgId).toBe('m1');
      expect(first.author).toBe('alice');
      expect(typeof first.ts).toBe('string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an error in one tick does not kill the loop', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('m1', { text: 'incident steady', ts: '2026-06-10T01:00:00.000Z' }),
    ]);

    const sync = spySync();
    // First tick throws (transient), subsequent ticks succeed.
    let firstCall = true;
    sync.ensureRoomSynced.mockImplementation(async () => {
      if (firstCall) {
        firstCall = false;
        throw new Error('transient sync failure');
      }
    });

    const app = makeApp(db, sync, fakeRc());
    const controller = new AbortController();

    const matches: string[] = [];

    // Fake timers so the 15s inter-tick sleep advances instantly. We pump the
    // timer forward after the loop yields on its sleep.
    vi.useFakeTimers();
    try {
      const p = new WatchService(app).watch({
        query: 'incident',
        room: 'r1',
        intervalSeconds: 15,
        signal: controller.signal,
        sinceTs: '2026-06-10T00:00:00.000Z',
        onMatch: (m) => {
          matches.push(m.id);
          controller.abort(); // stop after the first real match
        },
      });

      // Drive: tick1 (throws) → sleep → tick2 (match) → abort.
      // Flush microtasks + advance the fake clock until the loop settles.
      for (let i = 0; i < 5 && matches.length === 0; i++) {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      await p;
    } finally {
      vi.useRealTimers();
    }

    // First tick threw; second tick delivered the match → loop survived.
    expect(matches).toEqual(['m1']);
    expect(sync.ensureRoomSynced.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
