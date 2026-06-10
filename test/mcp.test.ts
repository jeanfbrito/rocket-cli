import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type Db } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';
import { buildServer } from '../src/mcp/server.js';

/** Minimal fake RcClient — mirrors test/app.test.ts. */
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

/** Connect an in-memory client to a server built around `app`. */
async function connect(app: App): Promise<Client> {
  const server = buildServer(app);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

/** Parse the text content of a tool result as JSON. */
function resultJson(res: unknown): any {
  const r = res as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text);
}

function resultText(res: unknown): string {
  const r = res as { content: Array<{ type: string; text: string }> };
  return r.content[0]!.text;
}

describe('mcp server', () => {
  let db: Db;
  let rc: FakeRc;
  let app: App;
  let client: Client;

  beforeEach(() => {
    db = openDb(':memory:');
    rc = new FakeRc();
    app = makeApp(db, rc);
  });

  afterEach(async () => {
    await client?.close();
    db?.close();
  });

  it('lists exactly six tools with readOnlyHint on the five read tools', async () => {
    client = await connect(app);
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'get_messages',
        'get_thread_messages',
        'list_rooms',
        'list_threads',
        'search_messages',
        'send_message',
      ].sort(),
    );

    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(
      [
        'get_messages',
        'get_thread_messages',
        'list_rooms',
        'list_threads',
        'search_messages',
      ].sort(),
    );

    const send = tools.find((t) => t.name === 'send_message')!;
    expect(send.annotations?.readOnlyHint).not.toBe(true);
  });

  it('list_rooms returns seeded rooms with type mapping', async () => {
    rc.onGet('/v1/subscriptions.get', {
      update: [
        sub({ rid: 'C1', name: 'general', fname: 'General', t: 'c' }),
        sub({ rid: 'P1', name: 'secret', fname: 'Secret', t: 'p' }),
        sub({ rid: 'D1', name: 'bob', fname: 'Bob', t: 'd' }),
      ],
      remove: [],
    });
    client = await connect(app);

    const res = await client.callTool({ name: 'list_rooms', arguments: {} });
    const payload = resultJson(res);

    expect(payload.returned).toBe(3);
    const byId = Object.fromEntries(payload.rooms.map((r: any) => [r.id, r]));
    expect(byId['C1'].type).toBe('channel');
    expect(byId['P1'].type).toBe('group');
    expect(byId['D1'].type).toBe('dm');
    expect(byId['C1'].displayName).toBe('General');
  });

  it('get_messages returns an envelope of compact messages with coverage', async () => {
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    // One full backfill page that is short -> fully backfilled.
    rc.onGet('/v1/channels.history', {
      messages: [
        { _id: 'm2', rid: 'C1', msg: 'second', ts: '2026-06-10T00:02:00.000Z', u: { _id: 'u1', username: 'alice' } },
        { _id: 'm1', rid: 'C1', msg: 'first', ts: '2026-06-10T00:01:00.000Z', u: { _id: 'u2', username: 'bob' }, tcount: 2, tlm: '2026-06-10T00:05:00.000Z' },
      ],
    });
    client = await connect(app);

    const res = await client.callTool({ name: 'get_messages', arguments: { room: '#general', count: 10 } });
    const payload = resultJson(res);

    expect(payload.room).toEqual({ id: 'C1', name: 'general', type: 'channel' });
    expect(payload.coverage).toBe('full');
    expect(typeof payload.syncedThrough).toBe('string');
    expect(payload.messages).toHaveLength(2);
    // Newest first.
    expect(payload.messages[0].id).toBe('m2');
    expect(payload.messages[0].author).toBe('alice');
    // Thread parent surfaces a replyCount.
    expect(payload.messages[1].replyCount).toBe(2);
  });

  it('get_thread_messages returns the parent plus ordered replies', async () => {
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    // Parent already cached. Mark the room synced recently so ensureRoomSynced
    // (invoked by ensureThreadLoaded) treats it as fresh and skips the network.
    db.setRoomSyncState('C1', { lastSyncedAt: new Date().toISOString() });
    db.upsertMessages([
      { id: 'P', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent', ts: '2026-06-10T00:00:00.000Z', tmid: null, tcount: 2, tlm: '2026-06-10T00:03:00.000Z', edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);
    // ensureThreadLoaded sees tcount(2) > localCount(0) -> fetches thread.
    rc.onGet('/v1/chat.getThreadMessages', {
      total: 2,
      messages: [
        { _id: 'r1', rid: 'C1', msg: 'reply one', ts: '2026-06-10T00:01:00.000Z', tmid: 'P', u: { _id: 'u2', username: 'bob' } },
        { _id: 'r2', rid: 'C1', msg: 'reply two', ts: '2026-06-10T00:02:00.000Z', tmid: 'P', u: { _id: 'u3', username: 'carol' } },
      ],
    });
    client = await connect(app);

    const res = await client.callTool({ name: 'get_thread_messages', arguments: { threadId: 'P' } });
    const payload = resultJson(res);

    expect(payload.parent.id).toBe('P');
    expect(payload.parent.text).toBe('parent');
    expect(payload.messages.map((m: any) => m.id)).toEqual(['r1', 'r2']);
    expect(payload.room.id).toBe('C1');
  });

  it('send_message routes #chan to a channel param and upserts the response', async () => {
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    rc.onPost('/v1/chat.postMessage', {
      message: { _id: 'sent1', rid: 'C1', msg: 'hello there', ts: '2026-06-10T03:00:00.000Z', u: { _id: 'u1', username: 'alice' } },
    });
    client = await connect(app);

    const res = await client.callTool({ name: 'send_message', arguments: { target: '#general', text: 'hello there' } });
    const payload = resultJson(res);

    expect(rc.posts).toHaveLength(1);
    expect(rc.posts[0]!.body).toMatchObject({ channel: '#general', text: 'hello there' });
    expect(rc.posts[0]!.body).not.toHaveProperty('roomId');
    expect(payload.sent.id).toBe('sent1');
    // Write-through: readable from the cache without a sync.
    expect(db.getMessage('sent1')?.text).toBe('hello there');
  });

  it('returns isError with a not-found message for an unknown room', async () => {
    // No rooms seeded; subscriptions refresh returns nothing.
    rc.onGet('/v1/subscriptions.get', { update: [], remove: [] });
    client = await connect(app);

    const res = (await client.callTool({ name: 'get_messages', arguments: { room: '#nope' } })) as {
      isError?: boolean;
    };

    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/not found/i);
  });
});
