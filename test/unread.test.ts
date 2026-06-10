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

  it('returns an empty report when everything is read (all caught up)', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, tunread: [] })],
      remove: [],
    });

    const report = await collectUnread(app);
    expect(report.rooms).toEqual([]);
    expect(report.totals).toEqual({ rooms: 0, messages: 0, threads: 0 });
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
