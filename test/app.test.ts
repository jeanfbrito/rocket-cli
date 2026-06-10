import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { sendMessage, type App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';

/** Minimal fake RcClient. */
class FakeRc {
  posts: Array<{ endpoint: string; body: Record<string, unknown> }> = [];
  gets: Array<{ endpoint: string; params?: Record<string, unknown> }> = [];

  private getResponses = new Map<string, unknown[]>();
  private postResponses = new Map<string, unknown[]>();

  onGet(endpoint: string, ...responses: unknown[]): this {
    this.getResponses.set(endpoint, responses);
    return this;
  }

  onPost(endpoint: string, ...responses: unknown[]): this {
    this.postResponses.set(endpoint, responses);
    return this;
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    this.gets.push({ endpoint, params });
    const queue = this.getResponses.get(endpoint);
    if (!queue || queue.length === 0) throw new Error(`FakeRc: no GET queued for ${endpoint}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next as T;
  }

  async post<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
    this.posts.push({ endpoint, body: body ?? {} });
    const queue = this.postResponses.get(endpoint);
    if (!queue || queue.length === 0) throw new Error(`FakeRc: no POST queued for ${endpoint}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return next as T;
  }
}

function sub(over: Partial<RcSubscription>): RcSubscription {
  return { rid: 'r', name: 'name', fname: 'fname', t: 'c', unread: 0, ...over };
}

function makeApp(db: Db, rc: FakeRc): App {
  const rooms = new RoomDirectory(db, rc as never);
  const sync = new SyncEngine(db, rc as never, rooms, { ttlSeconds: 60, backfillLimit: 100 });
  const search = new SearchService(db, rc as never, sync);
  const config = {
    url: 'http://example.com',
    token: 'tok',
    userId: 'uid',
    dbPath: ':memory:',
    ttlSeconds: 60,
    backfillLimit: 100,
  };
  return { config, db, rc: rc as never, rooms, sync, search };
}

describe('sendMessage', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('passes channel param untouched for #chan target', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.onPost('/v1/chat.postMessage', {
      message: { _id: 'm1', rid: 'GENERAL', msg: 'hello', ts: '2026-06-10T00:00:00.000Z', u: { _id: 'u1', username: 'alice' } },
    });
    const app = makeApp(db, rc);
    db.upsertRoom({ rid: 'GENERAL', name: 'general', fname: 'general', t: 'c', unread: 0, sub_updated_at: null });

    const compact = await sendMessage(app, { target: '#general', text: 'hello' });

    expect(rc.posts).toHaveLength(1);
    expect(rc.posts[0]!.body).toMatchObject({ channel: '#general', text: 'hello' });
    expect(rc.posts[0]!.body).not.toHaveProperty('roomId');
    expect(compact.id).toBe('m1');
  });

  it('resolves room name to roomId for bare room name target', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.onGet('/v1/subscriptions.get', {
      update: [sub({ rid: 'GENERAL', name: 'general' })],
      remove: [],
    });
    rc.onPost('/v1/chat.postMessage', {
      message: { _id: 'm2', rid: 'GENERAL', msg: 'hi', ts: '2026-06-10T00:00:00.000Z', u: { _id: 'u1', username: 'bob' } },
    });
    const app = makeApp(db, rc);
    await app.rooms.refresh();

    const compact = await sendMessage(app, { target: 'general', text: 'hi' });

    expect(rc.posts[0]!.body).toMatchObject({ roomId: 'GENERAL', text: 'hi' });
    expect(rc.posts[0]!.body).not.toHaveProperty('channel');
    expect(compact.id).toBe('m2');
  });

  it('maps threadId to tmid in the POST body', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.onPost('/v1/chat.postMessage', {
      message: { _id: 'm3', rid: 'R1', msg: 'reply', ts: '2026-06-10T00:00:00.000Z', u: { _id: 'u1', username: 'alice' } },
    });
    const app = makeApp(db, rc);
    db.upsertRoom({ rid: 'R1', name: 'chan', fname: 'chan', t: 'c', unread: 0, sub_updated_at: null });

    await sendMessage(app, { target: '#chan', text: 'reply', threadId: 'parent-msg-id' });

    expect(rc.posts[0]!.body).toMatchObject({ tmid: 'parent-msg-id' });
  });

  it('upserts the response message into db so it is readable after', async () => {
    db = openDb(':memory:');
    const rc = new FakeRc();
    rc.onPost('/v1/chat.postMessage', {
      message: { _id: 'msg-xyz', rid: 'ROOM1', msg: 'stored', ts: '2026-06-10T12:00:00.000Z', u: { _id: 'u1', username: 'charlie' } },
    });
    const app = makeApp(db, rc);
    db.upsertRoom({ rid: 'ROOM1', name: 'room1', fname: 'room1', t: 'c', unread: 0, sub_updated_at: null });

    await sendMessage(app, { target: '#room1', text: 'stored' });

    const row = db.getMessage('msg-xyz');
    expect(row).toBeDefined();
    expect(row?.text).toBe('stored');
    expect(row?.rid).toBe('ROOM1');
    expect(row?.author_username).toBe('charlie');
  });
});
