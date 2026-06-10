import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { sendMessage, type App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';

/**
 * Fake RcClient implementing the full typed endpoint surface. Each method
 * returns a sensible empty default unless a response is queued via the matching
 * `onX` setter. `postMessage` calls are recorded in `posts` for assertions.
 */
class FakeRc {
  posts: Array<{ body: Record<string, unknown> }> = [];

  private subscriptions: unknown = { update: [], remove: [] };
  private postMessageResponses: unknown[] = [];

  onSubscriptions(response: unknown): this {
    this.subscriptions = response;
    return this;
  }

  onPostMessage(...responses: unknown[]): this {
    this.postMessageResponses = responses;
    return this;
  }

  async getSubscriptions(): Promise<any> {
    return this.subscriptions;
  }

  async postMessage(body: Record<string, unknown>): Promise<any> {
    this.posts.push({ body });
    if (this.postMessageResponses.length === 0) {
      throw new Error('FakeRc: no postMessage response queued');
    }
    const next =
      this.postMessageResponses.length > 1
        ? this.postMessageResponses.shift()
        : this.postMessageResponses[0];
    return next;
  }

  // Remaining typed methods — empty defaults so SyncEngine/RoomDirectory paths
  // never blow up regardless of which scenario is under test.
  async getHistory(): Promise<any> {
    return { messages: [] };
  }
  async syncMessages(): Promise<any> {
    return { result: { updated: [], deleted: [] } };
  }
  async getThreadMessages(): Promise<any> {
    return { messages: [], total: 0 };
  }
  async getThreadsList(): Promise<any> {
    return { threads: [], total: 0 };
  }
  async searchMessages(): Promise<any> {
    return { messages: [] };
  }
  async react(): Promise<any> {
    return { success: true };
  }
  async userInfo(): Promise<any> {
    return { user: {} };
  }
  async getMessage(): Promise<any> {
    return { message: {} };
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
    rc.onPostMessage({
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
    rc.onSubscriptions({
      update: [sub({ rid: 'GENERAL', name: 'general' })],
      remove: [],
    });
    rc.onPostMessage({
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
    rc.onPostMessage({
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
    rc.onPostMessage({
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
