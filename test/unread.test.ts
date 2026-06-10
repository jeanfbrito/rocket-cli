import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';
import { collectUnread } from '../src/core/unread.js';

/**
 * Recording fake RcClient. Every method logs its name into `calls` so the guard
 * test can assert which endpoints were touched. Returns benign empty defaults so
 * the sync paths never blow up; scenarios override via the onX setters.
 *
 * The fake deliberately exposes NO read/markRead-style method (the real
 * RcClient does not either) — if collectUnread ever tried to call one, it would
 * throw "is not a function", and the guard test additionally asserts the call
 * log contains only read-only methods.
 */
class RecordingRc {
  calls: string[] = [];

  private subscriptions: unknown = { update: [], remove: [] };
  private history: unknown = { messages: [] };
  private threadMessages: unknown = { messages: [], total: 0 };

  onSubscriptions(response: unknown): this {
    this.subscriptions = response;
    return this;
  }
  onHistory(response: unknown): this {
    this.history = response;
    return this;
  }
  onThreadMessages(response: unknown): this {
    this.threadMessages = response;
    return this;
  }

  async getSubscriptions(): Promise<any> {
    this.calls.push('getSubscriptions');
    return this.subscriptions;
  }
  async getHistory(): Promise<any> {
    this.calls.push('getHistory');
    return this.history;
  }
  async syncMessages(): Promise<any> {
    this.calls.push('syncMessages');
    return { result: { updated: [], deleted: [] } };
  }
  async getThreadMessages(): Promise<any> {
    this.calls.push('getThreadMessages');
    return this.threadMessages;
  }
  async getThreadsList(): Promise<any> {
    this.calls.push('getThreadsList');
    return { threads: [], total: 0 };
  }
  async searchMessages(): Promise<any> {
    this.calls.push('searchMessages');
    return { messages: [] };
  }
  async getMessage(): Promise<any> {
    this.calls.push('getMessage');
    return { message: {} };
  }
  async postMessage(): Promise<any> {
    this.calls.push('postMessage');
    throw new Error('postMessage must never be called by the unread view');
  }
  async react(): Promise<any> {
    this.calls.push('react');
    throw new Error('react must never be called by the unread view');
  }
  async userInfo(): Promise<any> {
    this.calls.push('userInfo');
    return {};
  }
  async listCustomEmojis(): Promise<any> {
    this.calls.push('listCustomEmojis');
    return { emojis: { update: [], remove: [] } };
  }
}

function sub(over: Partial<RcSubscription>): RcSubscription {
  return { rid: 'r', name: 'name', fname: 'fname', t: 'c', unread: 0, ...over };
}

function makeApp(db: Db, rc: RecordingRc): App {
  const rooms = new RoomDirectory(db, rc as never);
  const emojis = new EmojiDirectory(
    db,
    rc as never,
    { url: 'http://example.com', token: 'tok', userId: 'uid' },
    true,
  );
  // Large TTL so a freshly-synced room is never re-fetched mid-test.
  const sync = new SyncEngine(db, rc as never, rooms, { ttlSeconds: 3600, backfillLimit: 100 });
  const search = new SearchService(db, rc as never, sync, 'http://example.com');
  const config = {
    url: 'http://example.com',
    token: 'tok',
    userId: 'uid',
    dbPath: ':memory:',
    ttlSeconds: 3600,
    backfillLimit: 100,
    emojiImages: true,
  };
  return { config, db, rc: rc as never, rooms, emojis, sync, search };
}

/**
 * Seed a room row so message upserts satisfy the FK and ensureRoomSynced is a
 * no-op. The room is also re-upserted by collectUnread's rooms.refresh(); the
 * upsert is idempotent and the subscription values (ls/unread/tunread) win.
 */
function seedRoom(db: Db, rid: string): void {
  db.upsertRoom({ rid, name: rid, fname: rid, t: 'c', unread: 0, sub_updated_at: null });
  db.setRoomSyncState(rid, { lastSyncedAt: new Date().toISOString() });
}

describe('collectUnread', () => {
  let db: Db;
  let rc: RecordingRc;
  let app: App;

  beforeEach(() => {
    db = openDb(':memory:');
    rc = new RecordingRc();
    app = makeApp(db, rc);
  });

  afterEach(() => {
    db?.close();
  });

  it('slices exactly the messages with ts > ls (last-read watermark)', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 2, ls })], remove: [] });
    // Room already synced; seed timeline around the watermark.
    seedRoom(db, 'C1');
    db.upsertMessages([
      { id: 'old', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'read already', ts: '2026-06-10T11:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'new1', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'unread one', ts: '2026-06-10T13:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'new2', rid: 'C1', author_id: 'u3', author_username: 'carol', author_name: 'Carol', text: 'unread two', ts: '2026-06-10T14:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const report = await collectUnread(app);

    expect(report.rooms).toHaveLength(1);
    const r = report.rooms[0]!;
    expect(r.room).toEqual({ id: 'C1', name: 'general', type: 'channel' });
    expect(r.unreadCount).toBe(2);
    expect(r.approximate).toBe(false);
    // Only ts > ls, chronological order.
    expect(r.messages.map((m) => m.id)).toEqual(['new1', 'new2']);
    // Each unread message carries a permalink against the configured URL.
    expect(r.messages.map((m) => m.link)).toEqual([
      'http://example.com/channel/general?msg=new1',
      'http://example.com/channel/general?msg=new2',
    ]);
    expect(report.totals).toEqual({ rooms: 1, messages: 2, threads: 0 });
  });

  it('includes unread thread replies (ts > ls) from tunread', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, ls, tunread: ['P'] })],
      remove: [],
    });
    seedRoom(db, 'C1');
    // Parent already cached with all replies; tcount matches local count so
    // ensureThreadLoaded does no network fetch.
    db.upsertMessages([
      { id: 'P', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent question that is quite a bit longer than fifty characters for the preview', ts: '2026-06-10T10:00:00.000Z', tmid: null, tcount: 2, tlm: '2026-06-10T13:00:00.000Z', edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'rOld', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'old reply', ts: '2026-06-10T11:00:00.000Z', tmid: 'P', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'rNew', rid: 'C1', author_id: 'u3', author_username: 'carol', author_name: 'Carol', text: 'fresh reply', ts: '2026-06-10T13:00:00.000Z', tmid: 'P', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });

    const report = await collectUnread(app);

    const r = report.rooms[0]!;
    expect(r.unreadThreads).toHaveLength(1);
    expect(r.unreadThreads[0]!.parent.id).toBe('P');
    // Parent and replies both carry permalinks.
    expect(r.unreadThreads[0]!.parent.link).toBe('http://example.com/channel/general?msg=P');
    // Only the reply newer than ls.
    expect(r.unreadThreads[0]!.messages.map((m) => m.id)).toEqual(['rNew']);
    expect(r.unreadThreads[0]!.messages[0]!.link).toBe('http://example.com/channel/general?msg=rNew');
    expect(report.totals.threads).toBe(1);
  });

  it('respects includeThreads=false', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, ls, tunread: ['P'] })],
      remove: [],
    });
    seedRoom(db, 'C1');
    db.upsertMessages([
      { id: 'P', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent', ts: '2026-06-10T10:00:00.000Z', tmid: null, tcount: 1, tlm: '2026-06-10T13:00:00.000Z', edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const report = await collectUnread(app, { includeThreads: false });
    expect(report.rooms[0]!.unreadThreads).toEqual([]);
  });

  it('falls back to newest-N approximation when ls is null', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 2 })], // no ls
      remove: [],
    });
    seedRoom(db, 'C1');
    db.upsertMessages([
      { id: 'm1', rid: 'C1', author_id: 'u1', author_username: 'a', author_name: 'A', text: 'one', ts: '2026-06-10T01:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'm2', rid: 'C1', author_id: 'u1', author_username: 'a', author_name: 'A', text: 'two', ts: '2026-06-10T02:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'm3', rid: 'C1', author_id: 'u1', author_username: 'a', author_name: 'A', text: 'three', ts: '2026-06-10T03:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const report = await collectUnread(app);
    const r = report.rooms[0]!;
    expect(r.approximate).toBe(true);
    // Newest `unread` (2) messages, chronological.
    expect(r.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('lists an alert-only room (unread=0, alert=true) sliced by ls', async () => {
    // Reproduces the real bug: on a server whose Unread_Count is the default
    // 'user_and_group_mentions_only', a plain channel message leaves unread=0
    // and tunread=[] but flips the sidebar `alert` flag. The room must still
    // appear, sliced exactly by the last-read watermark, and be flagged
    // activityOnly so the count can be labeled honestly.
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onSubscriptions({
      update: [
        sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, alert: true, tunread: [], ls }),
      ],
      remove: [],
    });
    seedRoom(db, 'C1');
    db.upsertMessages([
      { id: 'old', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'already read', ts: '2026-06-10T11:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'new1', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'plain unread message', ts: '2026-06-10T13:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const report = await collectUnread(app);

    expect(report.rooms).toHaveLength(1);
    const r = report.rooms[0]!;
    expect(r.room.name).toBe('general');
    expect(r.unreadCount).toBe(0);
    expect(r.activityOnly).toBe(true);
    expect(r.approximate).toBe(false);
    // Sliced exactly by ls — only the message after the watermark.
    expect(r.messages.map((m) => m.id)).toEqual(['new1']);
  });

  it('STALENESS REGRESSION: force-refreshes even when the cache is fresh', async () => {
    // Seed a fresh refresh timestamp so a TTL-gated ensureFresh() would skip the
    // network entirely. Pre-seed the cached room as fully read (unread=0,
    // alert=0). collectUnread MUST still call getSubscriptions and pick up the
    // changed server state — a 5-min-stale unread answer is wrong by design.
    db.setMeta('rooms_refreshed_at', new Date().toISOString());
    seedRoom(db, 'C1');
    db.upsertRoom({
      rid: 'C1', name: 'general', fname: 'general', t: 'c',
      unread: 0, alert: 0, tunread: '[]', ls: '2026-06-10T12:00:00.000Z',
      sub_updated_at: null,
    });
    db.upsertMessages([
      { id: 'new1', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'arrived after last refresh', ts: '2026-06-10T13:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);
    // Server now reports the room as alert-only unread, contradicting the cache.
    rc.onSubscriptions({
      update: [
        sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, alert: true, tunread: [], ls: '2026-06-10T12:00:00.000Z' }),
      ],
      remove: [],
    });

    const report = await collectUnread(app);

    // Network was hit despite the fresh cache, and the room is now surfaced.
    expect(rc.calls).toContain('getSubscriptions');
    expect(report.rooms.map((r) => r.room.name)).toEqual(['general']);
    expect(report.rooms[0]!.activityOnly).toBe(true);
  });

  it('returns an empty report when everything is read (all caught up)', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, tunread: [] })],
      remove: [],
    });

    const report = await collectUnread(app);
    expect(report.rooms).toEqual([]);
    expect(report.totals).toEqual({ rooms: 0, messages: 0, threads: 0 });
  });

  it('SWR: an already-synced but stale unread room serves from cache and flags refreshing', async () => {
    // Build an app whose sync TTL is 0 so an already-synced room is stale and
    // takes the SWR serve-now-revalidate-later branch.
    const swrDb = openDb(':memory:');
    const swrRc = new RecordingRc();
    const rooms = new RoomDirectory(swrDb, swrRc as never);
    const emojis = new EmojiDirectory(swrDb, swrRc as never, { url: 'http://example.com', token: 'tok', userId: 'uid' }, true);
    const swrSync = new SyncEngine(swrDb, swrRc as never, rooms, { ttlSeconds: 0, backfillLimit: 100 });
    const search = new SearchService(swrDb, swrRc as never, swrSync, 'http://example.com');
    const swrApp = {
      config: { url: 'http://example.com', token: 'tok', userId: 'uid', dbPath: ':memory:', ttlSeconds: 0, backfillLimit: 100, emojiImages: true },
      db: swrDb, rc: swrRc as never, rooms, emojis, sync: swrSync, search,
    } as unknown as App;

    const ls = '2026-06-10T12:00:00.000Z';
    swrRc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 1, ls })], remove: [] });
    // Already synced (stale, since TTL 0). The unread slice is already cached.
    swrDb.upsertRoom({ rid: 'C1', name: 'general', fname: 'general', t: 'c', unread: 1, sub_updated_at: null });
    swrDb.setRoomSyncState('C1', { lastSyncedAt: '2026-06-10T11:00:00.000Z' });
    swrDb.upsertMessages([
      { id: 'new1', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'unread', ts: '2026-06-10T13:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);

    const report = await collectUnread(swrApp);

    // Served the cached slice immediately, flagged refreshing (background delta kicked).
    expect(report.refreshing).toBe(true);
    expect(report.rooms[0]!.messages.map((m) => m.id)).toEqual(['new1']);
    // Delta WAS kicked in the background (recorded), but the report did not wait
    // on its result before returning.
    await new Promise((r) => setTimeout(r, 0));
    expect(swrRc.calls).toContain('syncMessages');
    swrDb.close();
  });

  it('SHALLOW: never-synced unread rooms hit getHistory once each, not the full backfill', async () => {
    // Three never-synced unread rooms with last-read watermarks. The default
    // RecordingRc.getHistory returns an empty (short) page, so the shallow sync
    // settles in exactly one history call per room — the whole point of the
    // cold-start optimization (vs. the multi-page full backfill).
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onSubscriptions({
      update: [
        sub({ rid: 'C1', name: 'one', t: 'c', unread: 1, ls }),
        sub({ rid: 'C2', name: 'two', t: 'c', unread: 1, ls }),
        sub({ rid: 'C3', name: 'three', t: 'c', unread: 1, ls }),
      ],
      remove: [],
    });
    // NOTE: no seedRoom → rooms are never-synced (last_synced_at null), so the
    // shallow path runs its single history window (not delta).

    const report = await collectUnread(app);

    // One history call per never-synced room: 3 total (not 3 × 5 = 15).
    expect(rc.calls.filter((c) => c === 'getHistory')).toHaveLength(3);
    // Never ran a delta on these (never-synced → history, not syncMessages).
    expect(rc.calls).not.toContain('syncMessages');
    expect(report.rooms.map((r) => r.room.id).sort()).toEqual(['C1', 'C2', 'C3']);

    // All three are now shallowly known: watermark set, horizon = ls, partial.
    for (const rid of ['C1', 'C2', 'C3']) {
      const r = db.getRoom(rid)!;
      expect(r.last_synced_at).toBeDefined();
      expect(r.oldest_loaded_ts).toBe(ls);
      expect(r.fully_backfilled).toBe(0);
    }
  });

  it('GUARD: never calls any read/markRead-style endpoint', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 1, ls, tunread: ['P'] })],
      remove: [],
    });
    seedRoom(db, 'C1');
    db.upsertMessages([
      { id: 'P', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent', ts: '2026-06-10T10:00:00.000Z', tmid: null, tcount: 1, tlm: '2026-06-10T13:00:00.000Z', edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'rNew', rid: 'C1', author_id: 'u3', author_username: 'carol', author_name: 'Carol', text: 'reply', ts: '2026-06-10T13:00:00.000Z', tmid: 'P', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'new1', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'unread', ts: '2026-06-10T13:30:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });

    await collectUnread(app);

    // Allowed read-only endpoints only. Crucially: NO subscriptions.read /
    // markRead / unread-toggle endpoint exists or was called, and no mutating
    // postMessage/react.
    const allowed = new Set([
      'getSubscriptions',
      'getHistory',
      'syncMessages',
      'getThreadMessages',
      'getThreadsList',
      'getMessage',
    ]);
    const forbidden = rc.calls.filter((c) => !allowed.has(c));
    expect(forbidden).toEqual([]);
    expect(rc.calls).not.toContain('postMessage');
    expect(rc.calls).not.toContain('react');
    // Sanity: it DID refresh subscriptions (the read-only data source).
    expect(rc.calls).toContain('getSubscriptions');
  });
});
