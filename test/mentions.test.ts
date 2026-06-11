import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type MessageRow } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';
import { collectMentions } from '../src/core/mentions.js';

/**
 * Recording fake RcClient. Logs every method call so tests can assert which
 * endpoints were touched (e.g. userInfo is called exactly once then cached).
 * userInfo returns the configured username; everything else returns benign
 * empty defaults so the read-only sync paths never blow up.
 */
class RecordingRc {
  calls: string[] = [];
  private subscriptions: unknown = { update: [], remove: [] };
  private username: string | undefined = 'jean';

  onSubscriptions(response: unknown): this {
    this.subscriptions = response;
    return this;
  }
  onUsername(username: string | undefined): this {
    this.username = username;
    return this;
  }

  async getSubscriptions(): Promise<any> {
    this.calls.push('getSubscriptions');
    return this.subscriptions;
  }
  async getHistory(): Promise<any> {
    this.calls.push('getHistory');
    return { messages: [] };
  }
  async syncMessages(): Promise<any> {
    this.calls.push('syncMessages');
    return { result: { updated: [], deleted: [] } };
  }
  async getThreadMessages(): Promise<any> {
    this.calls.push('getThreadMessages');
    return { messages: [], total: 0 };
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
    throw new Error('postMessage must never be called by the mentions view');
  }
  async react(): Promise<any> {
    this.calls.push('react');
    throw new Error('react must never be called by the mentions view');
  }
  async userInfo(): Promise<any> {
    this.calls.push('userInfo');
    return { user: { _id: 'uid', username: this.username } };
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
    readOnly: false,
  };
  return { config, db, rc: rc as never, rooms, emojis, sync, search };
}

/** Seed a room so message upserts satisfy the FK and ensureRoomSynced no-ops. */
function seedRoom(db: Db, rid: string, over: Partial<{ unread: number }> = {}): void {
  db.upsertRoom({
    rid,
    name: rid,
    fname: rid,
    t: 'c',
    unread: over.unread ?? 0,
    sub_updated_at: null,
  });
  db.setRoomSyncState(rid, { lastSyncedAt: new Date().toISOString() });
}

/** A non-deleted message row carrying a mentions JSON array. */
function msg(id: string, rid: string, mentions: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    rid,
    author_id: 'u1',
    author_username: 'alice',
    author_name: 'Alice',
    text: `msg ${id}`,
    ts: '2026-06-10T12:00:00.000Z',
    tmid: null,
    tcount: null,
    tlm: null,
    edited_at: null,
    system_type: null,
    attachments_json: null,
    deleted: 0,
    updated_at: null,
    mentions,
    ...over,
  };
}

describe('collectMentions', () => {
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

  it('groups my mentions by room with links, totals, and searchedSince', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 1 })],
      remove: [],
    });
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg('me1', 'C1', '["jean"]', { ts: '2026-06-10T11:00:00.000Z' }),
      msg('me2', 'C1', '["bob","jean"]', { ts: '2026-06-10T13:00:00.000Z' }),
      msg('other', 'C1', '["bob"]', { ts: '2026-06-10T14:00:00.000Z' }),
    ]);

    const report = await collectMentions(app, { sinceDays: 30 });

    expect(report.mentions).toHaveLength(1);
    const r = report.mentions[0]!;
    expect(r.room).toEqual({ id: 'C1', name: 'general', type: 'channel' });
    // Newest first; only rows mentioning me.
    expect(r.messages.map((m) => m.id)).toEqual(['me2', 'me1']);
    expect(r.messages.map((m) => m.link)).toEqual([
      'http://example.com/channel/general?msg=me2',
      'http://example.com/channel/general?msg=me1',
    ]);
    expect(report.totals).toEqual({ rooms: 1, messages: 2 });
    expect(typeof report.searchedSince).toBe('string');
  });

  it('excludes mentions older than sinceDays', async () => {
    rc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c' })], remove: [] });
    seedRoom(db, 'C1');
    const now = Date.now();
    const recentTs = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const oldTs = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.upsertMessages([
      msg('recent', 'C1', '["jean"]', { ts: recentTs }),
      msg('ancient', 'C1', '["jean"]', { ts: oldTs }),
    ]);

    const report = await collectMentions(app, { sinceDays: 7 });
    const ids = report.mentions.flatMap((m) => m.messages.map((x) => x.id));
    expect(ids).toEqual(['recent']);
  });

  it('excludes @all/@here by default, includes them with includeChannelWide', async () => {
    rc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c' })], remove: [] });
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg('mine', 'C1', '["jean"]', { ts: '2026-06-10T11:00:00.000Z' }),
      msg('wide', 'C1', '["all"]', { ts: '2026-06-10T12:00:00.000Z' }),
      msg('here', 'C1', '["here"]', { ts: '2026-06-10T13:00:00.000Z' }),
    ]);

    const off = await collectMentions(app, { sinceDays: 30 });
    expect(off.mentions[0]!.messages.map((m) => m.id)).toEqual(['mine']);

    const on = await collectMentions(app, { sinceDays: 30, includeChannelWide: true });
    expect(on.mentions[0]!.messages.map((m) => m.id)).toEqual(['here', 'wide', 'mine']);
  });

  it('caches my_username after one userInfo call', async () => {
    rc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c' })], remove: [] });
    seedRoom(db, 'C1');
    db.upsertMessages([msg('m1', 'C1', '["jean"]')]);

    await collectMentions(app, { sinceDays: 30 });
    expect(rc.calls.filter((c) => c === 'userInfo')).toHaveLength(1);
    expect(db.getMeta('my_username')).toBe('jean');

    // Second run: username is cached, no further userInfo round-trip.
    await collectMentions(app, { sinceDays: 30 });
    expect(rc.calls.filter((c) => c === 'userInfo')).toHaveLength(1);
  });

  it('freshens rooms with unread activity (ensureRoomSynced via getSubscriptions)', async () => {
    rc.onSubscriptions({
      update: [
        sub({ rid: 'C1', name: 'general', t: 'c', unread: 3 }),
        sub({ rid: 'C2', name: 'random', t: 'c', unread: 0 }),
      ],
      remove: [],
    });
    // C1 has unread; seed it as already-synced so ensureRoomSynced is a no-op
    // but still exercised. C2 has no unread so it is not freshened.
    seedRoom(db, 'C1', { unread: 3 });
    seedRoom(db, 'C2');
    db.upsertMessages([msg('m1', 'C1', '["jean"]')]);

    await collectMentions(app, { sinceDays: 30 });

    // It refreshed subscriptions (the read-only data source).
    expect(rc.calls).toContain('getSubscriptions');
    // Never mutated anything.
    expect(rc.calls).not.toContain('postMessage');
    expect(rc.calls).not.toContain('react');
  });

  it('returns an empty report when nothing mentions me', async () => {
    rc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c' })], remove: [] });
    seedRoom(db, 'C1');
    db.upsertMessages([msg('m1', 'C1', '["bob"]')]);

    const report = await collectMentions(app, { sinceDays: 30 });
    expect(report.mentions).toEqual([]);
    expect(report.totals).toEqual({ rooms: 0, messages: 0 });
  });

  it('throws when userInfo cannot resolve a username', async () => {
    rc.onUsername(undefined);
    rc.onSubscriptions({ update: [], remove: [] });

    await expect(collectMentions(app, { sinceDays: 30 })).rejects.toThrow(/username/i);
  });
});
