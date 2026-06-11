import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type Db } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import { RcApiError } from '../src/core/errors.js';
import type { RcSubscription } from '../src/core/normalize.js';
import { buildServer } from '../src/mcp/server.js';

/**
 * Fake RcClient implementing the FULL typed endpoint surface (all 10 methods).
 * Every method has a sensible empty default so the SyncEngine/RoomDirectory
 * paths used by get_messages / list_threads / etc. never blow up; scenarios
 * override the specific method(s) they exercise via the `onX` setters.
 *
 * `postMessage` / `react` / `userInfo` calls record their arguments so tests
 * can assert on method + args (replacing the old endpoint-string assertions).
 */
class FakeRc {
  posts: Array<{ body: Record<string, unknown> }> = [];
  reacts: Array<{ body: Record<string, unknown> }> = [];
  userInfos: Array<{ params: Record<string, unknown> }> = [];

  private subscriptions: unknown = { update: [], remove: [] };
  private history: unknown = { messages: [] };
  private threadMessages: unknown = { messages: [], total: 0 };
  private postMessageResponses: unknown[] = [];
  private userInfoResponses: unknown[] = [];
  private customEmojis: unknown = { emojis: { update: [], remove: [] } };
  // When set, react() throws this instead of succeeding.
  private reactError: unknown = undefined;

  onCustomEmojis(response: unknown): this {
    this.customEmojis = response;
    return this;
  }

  failReactWith(err: unknown): this {
    this.reactError = err;
    return this;
  }

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

  onPostMessage(...responses: unknown[]): this {
    this.postMessageResponses = responses;
    return this;
  }

  onUserInfo(...responses: unknown[]): this {
    this.userInfoResponses = responses;
    return this;
  }

  async getSubscriptions(): Promise<any> {
    return this.subscriptions;
  }

  async getHistory(): Promise<any> {
    return this.history;
  }

  async syncMessages(): Promise<any> {
    return { result: { updated: [], deleted: [] } };
  }

  async getThreadMessages(): Promise<any> {
    return this.threadMessages;
  }

  async getThreadsList(): Promise<any> {
    return { threads: [], total: 0 };
  }

  async searchMessages(): Promise<any> {
    return { messages: [] };
  }

  async getMessage(): Promise<any> {
    return { message: {} };
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

  async react(body: Record<string, unknown>): Promise<any> {
    this.reacts.push({ body });
    if (this.reactError !== undefined) throw this.reactError;
    return { success: true };
  }

  async listCustomEmojis(): Promise<any> {
    return this.customEmojis;
  }

  async userInfo(params: Record<string, unknown>): Promise<any> {
    this.userInfos.push({ params });
    if (this.userInfoResponses.length === 0) {
      throw new Error('FakeRc: no userInfo response queued');
    }
    const next =
      this.userInfoResponses.length > 1
        ? this.userInfoResponses.shift()
        : this.userInfoResponses[0];
    return next;
  }
}

function sub(over: Partial<RcSubscription>): RcSubscription {
  return { rid: 'r', name: 'name', fname: 'fname', t: 'c', unread: 0, ...over };
}

function makeApp(db: Db, rc: FakeRc, opts?: { emojiImages?: boolean; readOnly?: boolean }): App {
  const emojiImages = opts?.emojiImages ?? true;
  const readOnly = opts?.readOnly ?? false;
  const rooms = new RoomDirectory(db, rc as never);
  const emojis = new EmojiDirectory(
    db,
    rc as never,
    { url: 'http://example.com', token: 'tok', userId: 'uid' },
    emojiImages,
  );
  const sync = new SyncEngine(db, rc as never, rooms, { ttlSeconds: 60, backfillLimit: 100 });
  const search = new SearchService(db, rc as never, sync, 'http://example.com');
  const config = {
    url: 'http://example.com',
    token: 'tok',
    userId: 'uid',
    dbPath: ':memory:',
    ttlSeconds: 60,
    backfillLimit: 100,
    emojiImages,
    readOnly,
  };
  return { config, db, rc: rc as never, rooms, emojis, sync, search };
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

  it('lists exactly eighteen tools with readOnlyHint on the read tools', async () => {
    client = await connect(app);
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(18);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_reaction',
        'download_attachment',
        'get_attention',
        'get_custom_emoji',
        'get_mentions',
        'get_message_context',
        'get_messages',
        'get_thread_messages',
        'get_unread',
        'get_user_profile',
        'list_custom_emojis',
        'list_rooms',
        'list_threads',
        'open_url',
        'search_messages',
        'send_message',
        'sync_history',
        'upload_file',
      ].sort(),
    );

    const readOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    expect(readOnly).toEqual(
      [
        'get_attention',
        'get_custom_emoji',
        'get_mentions',
        'get_message_context',
        'get_messages',
        'get_thread_messages',
        'get_unread',
        'get_user_profile',
        'list_custom_emojis',
        'list_rooms',
        'list_threads',
        'open_url',
        'search_messages',
        'sync_history',
      ].sort(),
    );

    const send = tools.find((t) => t.name === 'send_message')!;
    expect(send.annotations?.readOnlyHint).not.toBe(true);

    const reaction = tools.find((t) => t.name === 'add_reaction')!;
    expect(reaction.annotations?.readOnlyHint).not.toBe(true);
  });

  it('read-only mode registers exactly fifteen tools (no write tools)', async () => {
    const roDb = openDb(':memory:');
    const roRc = new FakeRc();
    const roApp = makeApp(roDb, roRc, { readOnly: true });
    const roClient = await connect(roApp);
    try {
      const { tools } = await roClient.listTools();
      expect(tools).toHaveLength(15);
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('send_message');
      expect(names).not.toContain('add_reaction');
      expect(names).not.toContain('upload_file');
      // download_attachment writes only local disk, so it stays available.
      expect(names).toContain('download_attachment');
      // sync_history writes only the local cache, so it stays available.
      expect(names).toContain('sync_history');

      // Reads still work in read-only mode.
      roRc.onSubscriptions({
        update: [sub({ rid: 'C1', name: 'general', fname: 'General', t: 'c' })],
        remove: [],
      });
      const res = await roClient.callTool({ name: 'list_rooms', arguments: {} });
      expect(resultJson(res).returned).toBe(1);
    } finally {
      await roClient.close();
      roDb.close();
    }
  });

  it('list_rooms returns seeded rooms with type mapping', async () => {
    rc.onSubscriptions({
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
    rc.onHistory({
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
    // Each message carries a clickable permalink against the configured URL.
    expect(payload.messages[0].link).toBe('http://example.com/channel/general?msg=m2');
    expect(payload.messages[1].link).toBe('http://example.com/channel/general?msg=m1');
  });

  it('get_unread reports messages and thread replies past the last-read watermark', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    // Subscription state drives the unread view: unread count, ls watermark,
    // and a thread parent with an unread reply.
    rc.onSubscriptions({
      update: [
        { rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 1, ls, tunread: ['P'] },
      ],
      remove: [],
    });
    // Room + thread already cached & synced so ensureRoomSynced/ensureThreadLoaded
    // hit no network. Seed messages around the watermark.
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    db.setRoomSyncState('C1', { lastSyncedAt: new Date().toISOString() });
    db.upsertMessages([
      { id: 'P', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent', ts: '2026-06-10T10:00:00.000Z', tmid: null, tcount: 1, tlm: '2026-06-10T13:00:00.000Z', edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'read1', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'already read', ts: '2026-06-10T11:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'unread1', rid: 'C1', author_id: 'u3', author_username: 'carol', author_name: 'Carol', text: 'unread main', ts: '2026-06-10T13:30:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'rNew', rid: 'C1', author_id: 'u4', author_username: 'dave', author_name: 'Dave', text: 'unread reply', ts: '2026-06-10T13:00:00.000Z', tmid: 'P', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });
    client = await connect(app);

    const res = await client.callTool({ name: 'get_unread', arguments: {} });
    const payload = resultJson(res);

    expect(payload.totals).toEqual({ rooms: 1, messages: 1, threads: 1 });
    const r = payload.rooms[0];
    expect(r.room).toEqual({ id: 'C1', name: 'general', type: 'channel' });
    expect(r.unreadCount).toBe(1);
    expect(r.approximate).toBe(false);
    expect(r.messages.map((m: any) => m.id)).toEqual(['unread1']);
    expect(r.unreadThreads[0].parent.id).toBe('P');
    expect(r.unreadThreads[0].messages.map((m: any) => m.id)).toEqual(['rNew']);
  });

  it('get_unread excludes a hidden room by default but includes it with includeHidden', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    // One visible unread room and one hidden ("Hide unread counter" on) room
    // with unread/alert but no mention. UI parity hides the latter by default.
    rc.onSubscriptions({
      update: [
        { rid: 'C1', name: 'visible', fname: 'Visible', t: 'c', unread: 1, alert: true, ls },
        { rid: 'C2', name: 'muted', fname: 'Muted', t: 'c', unread: 3, alert: true, ls, hideUnreadStatus: true },
      ],
      remove: [],
    });
    db.upsertRoom({ rid: 'C1', name: 'visible', fname: 'Visible', t: 'c', unread: 0, sub_updated_at: null });
    db.upsertRoom({ rid: 'C2', name: 'muted', fname: 'Muted', t: 'c', unread: 0, sub_updated_at: null });
    db.setRoomSyncState('C1', { lastSyncedAt: new Date().toISOString() });
    db.setRoomSyncState('C2', { lastSyncedAt: new Date().toISOString() });
    db.upsertMessages([
      { id: 'v1', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'visible unread', ts: '2026-06-10T13:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
      { id: 'm1', rid: 'C2', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'muted unread', ts: '2026-06-10T13:00:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null },
    ]);
    client = await connect(app);

    const def = resultJson(await client.callTool({ name: 'get_unread', arguments: {} }));
    expect(def.rooms.map((r: any) => r.room.id)).toEqual(['C1']);

    const all = resultJson(
      await client.callTool({ name: 'get_unread', arguments: { includeHidden: true } }),
    );
    expect(all.rooms.map((r: any) => r.room.id).sort()).toEqual(['C1', 'C2']);
  });

  it('get_attention prioritizes, dedupes, and sections by source', async () => {
    const ls = '2026-06-10T12:00:00.000Z';
    rc.onUserInfo({ user: { _id: 'uid', username: 'jean' } });
    // Two unread rooms: a channel (C1) and a DM (D1). C1 also carries a thread
    // with an unread reply.
    rc.onSubscriptions({
      update: [
        { rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 2, ls, tunread: ['P'] },
        { rid: 'D1', name: 'rocket.cat', fname: 'Rocket.Cat', t: 'd', unread: 1, ls },
      ],
      remove: [],
    });
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    db.upsertRoom({ rid: 'D1', name: 'rocket.cat', fname: 'Rocket.Cat', t: 'd', unread: 0, sub_updated_at: null });
    db.setRoomSyncState('C1', { lastSyncedAt: new Date().toISOString() });
    db.setRoomSyncState('D1', { lastSyncedAt: new Date().toISOString() });
    db.upsertMessages([
      // Thread parent (read) + its unread reply.
      { id: 'P', rid: 'C1', author_id: 'u1', author_username: 'alice', author_name: 'Alice', text: 'parent', ts: '2026-06-10T10:00:00.000Z', tmid: null, tcount: 1, tlm: '2026-06-10T13:00:00.000Z', edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null, mentions: '[]' },
      { id: 'tReply', rid: 'C1', author_id: 'u4', author_username: 'dave', author_name: 'Dave', text: 'unread reply', ts: '2026-06-10T13:00:00.000Z', tmid: 'P', tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null, mentions: '[]' },
      // Plain unread channel message mentioning jean -> appears in BOTH mentions
      // and channel-unread; must surface ONLY in mentions with alsoUnread.
      { id: 'cMention', rid: 'C1', author_id: 'u2', author_username: 'bob', author_name: 'Bob', text: 'hey @jean look', ts: '2026-06-10T13:30:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null, mentions: '["jean"]' },
      // Plain unread channel message, no mention -> channelUnreads.
      { id: 'cPlain', rid: 'C1', author_id: 'u3', author_username: 'carol', author_name: 'Carol', text: 'unrelated', ts: '2026-06-10T13:45:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null, mentions: '[]' },
      // Unread DM message, no mention -> directUnreads.
      { id: 'dm1', rid: 'D1', author_id: 'u5', author_username: 'cat', author_name: 'Rocket Cat', text: 'ping', ts: '2026-06-10T13:10:00.000Z', tmid: null, tcount: null, tlm: null, edited_at: null, system_type: null, attachments_json: null, deleted: 0, updated_at: null, mentions: '[]' },
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });
    client = await connect(app);

    const res = await client.callTool({
      name: 'get_attention',
      arguments: { sinceDays: 30 },
    });
    const payload = resultJson(res);

    // Mentions: the channel mention, flagged alsoUnread (it is also unread).
    expect(payload.mentions.map((i: any) => i.message.id)).toEqual(['cMention']);
    expect(payload.mentions[0].alsoUnread).toBe(true);
    expect(payload.mentions[0].room.id).toBe('C1');

    // The mentioned id must NOT reappear in any unread section (dedupe).
    const channelIds = payload.channelUnreads.map((i: any) => i.message.id);
    expect(channelIds).toContain('cPlain');
    expect(channelIds).not.toContain('cMention');

    // DM unread routed to directUnreads.
    expect(payload.directUnreads.map((i: any) => i.message.id)).toEqual(['dm1']);
    expect(payload.directUnreads[0].room.type).toBe('dm');

    // Thread reply surfaces under threadUnreads with its parent.
    expect(payload.threadUnreads).toHaveLength(1);
    expect(payload.threadUnreads[0].parent.id).toBe('P');
    expect(payload.threadUnreads[0].messages.map((m: any) => m.id)).toEqual(['tReply']);

    expect(payload.totals).toEqual({
      mentions: 1,
      directUnreads: 1,
      threadUnreads: 1,
      channelUnreads: 1,
      all: 4,
    });
    expect(typeof payload.searchedSince).toBe('string');
    expect(typeof payload.generatedAt).toBe('string');
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
    rc.onThreadMessages({
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
    rc.onPostMessage({
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
    rc.onSubscriptions({ update: [], remove: [] });
    client = await connect(app);

    const res = (await client.callTool({ name: 'get_messages', arguments: { room: '#nope' } })) as {
      isError?: boolean;
    };

    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/not found/i);
  });

  it('add_reaction calls react with colon-wrapped emoji', async () => {
    client = await connect(app);

    const res = await client.callTool({
      name: 'add_reaction',
      arguments: { messageId: 'msg1', emoji: ':tada:' },
    });
    const payload = resultJson(res);

    expect(rc.reacts).toHaveLength(1);
    expect(rc.reacts[0]!.body).toEqual({ messageId: 'msg1', emoji: ':tada:', shouldReact: true });
    expect(payload).toEqual({ reacted: true, messageId: 'msg1', emoji: ':tada:' });
  });

  it('add_reaction wraps emoji given without colons', async () => {
    client = await connect(app);

    await client.callTool({
      name: 'add_reaction',
      arguments: { messageId: 'msg2', emoji: 'tada' },
    });

    expect(rc.reacts[0]!.body).toMatchObject({ emoji: ':tada:' });
  });

  it('add_reaction with remove: true sends shouldReact false', async () => {
    client = await connect(app);

    const res = await client.callTool({
      name: 'add_reaction',
      arguments: { messageId: 'msg3', emoji: ':thumbsup:', remove: true },
    });
    const payload = resultJson(res);

    expect(rc.reacts[0]!.body).toMatchObject({ shouldReact: false });
    expect(payload.reacted).toBe(false);
  });

  it('get_user_profile strips leading @ and returns compact shape', async () => {
    rc.onUserInfo({
      user: {
        _id: 'uid42',
        username: 'alice',
        name: 'Alice Smith',
        status: 'online',
        statusText: 'coding',
        bio: 'engineer',
        utcOffset: -3,
        active: true,
        roles: ['user'],
        emails: [{ address: 'alice@example.com', verified: true }],
      },
    });
    client = await connect(app);

    const res = await client.callTool({
      name: 'get_user_profile',
      arguments: { user: '@alice' },
    });
    const payload = resultJson(res);

    // Verify @ was stripped and username query used.
    expect(rc.userInfos).toHaveLength(1);
    expect(rc.userInfos[0]!.params).toEqual({ username: 'alice' });

    expect(payload).toEqual({
      id: 'uid42',
      username: 'alice',
      name: 'Alice Smith',
      status: 'online',
      statusText: 'coding',
      bio: 'engineer',
      timezone: -3,
      roles: ['user'],
      email: 'alice@example.com',
    });
  });

  it('list_custom_emojis refreshes and returns names + aliases', async () => {
    // Background image fill (fire-and-forget) calls fetch; stub it so nothing
    // hits the network or leaks a handle.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })));
    rc.onCustomEmojis({
      emojis: {
        update: [
          { _id: 'e1', name: 'rocketcli', aliases: ['rkt'], extension: 'png' },
          { _id: 'e2', name: 'grinch', aliases: [], extension: 'gif' },
        ],
        remove: [],
      },
    });
    client = await connect(app);

    const res = await client.callTool({ name: 'list_custom_emojis', arguments: {} });
    const payload = resultJson(res);

    expect(payload.count).toBe(2);
    const names = payload.emojis.map((e: any) => e.name).sort();
    expect(names).toEqual(['grinch', 'rocketcli']);
    const rkt = payload.emojis.find((e: any) => e.name === 'rocketcli');
    expect(rkt.aliases).toEqual(['rkt']);

    vi.unstubAllGlobals();
  });

  it('add_reaction enriches an invalid-emoji error with suggestions', async () => {
    // Seed the emoji cache directly and freeze the watermark so suggest() reads
    // it without a refresh.
    db.upsertEmojis([
      { id: 'e1', name: 'rocketcli', aliases: JSON.stringify([]), extension: 'png', updated_at: null },
    ]);
    db.setMeta('emojis_refreshed_at', new Date().toISOString());
    rc.failReactWith(new RcApiError('Invalid emoji provided.', 400, { errorType: 'error-not-allowed' }));
    client = await connect(app);

    const res = (await client.callTool({
      name: 'add_reaction',
      arguments: { messageId: 'm1', emoji: 'rockt' },
    })) as { isError?: boolean };

    expect(res.isError).toBe(true);
    const text = resultText(res);
    expect(text).toMatch(/Invalid emoji/);
    expect(text).toMatch(/rocketcli/);
    expect(text).toMatch(/list_custom_emojis/);
  });

  it('sync_history deepens an explicit room and reports messagesLoaded + coverage', async () => {
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    rc.onSubscriptions({ update: [{ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0 }], remove: [] });
    // A single short history page → fully backfilled.
    rc.onHistory({
      messages: [
        { _id: 'h1', rid: 'C1', msg: 'older one', ts: '2026-06-01T00:01:00.000Z', u: { _id: 'u1', username: 'alice' } },
        { _id: 'h2', rid: 'C1', msg: 'older two', ts: '2026-06-01T00:02:00.000Z', u: { _id: 'u2', username: 'bob' } },
      ],
    });
    client = await connect(app);

    const res = await client.callTool({ name: 'sync_history', arguments: { room: '#general' } });
    const payload = resultJson(res);

    expect(payload.room.id).toBe('C1');
    expect(payload.messagesLoaded).toBe(2);
    expect(payload.coverage).toBe('full');
  });

  it('sync_history with no room reports nothing-to-do when all rooms are read', async () => {
    rc.onSubscriptions({ update: [{ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0 }], remove: [] });
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    client = await connect(app);

    const res = await client.callTool({ name: 'sync_history', arguments: {} });
    const payload = resultJson(res);
    expect(payload.room).toBeNull();
    expect(payload.messagesLoaded).toBe(0);
  });
});

describe('mcp emoji image tools', () => {
  let db: Db;
  let rc: FakeRc;
  let client: Client;

  afterEach(async () => {
    await client?.close();
    db?.close();
    vi.unstubAllGlobals();
  });

  it('get_custom_emoji returns image content for a seeded blob', async () => {
    db = openDb(':memory:');
    rc = new FakeRc();
    const app = makeApp(db, rc);
    db.upsertEmojis([
      { id: 'e1', name: 'rocketcli', aliases: JSON.stringify(['rkt']), extension: 'png', updated_at: null },
    ]);
    db.setEmojiImage('e1', Buffer.from([1, 2, 3, 4]), 'image/png');
    db.setMeta('emojis_refreshed_at', new Date().toISOString());
    client = await connect(app);

    const res = (await client.callTool({
      name: 'get_custom_emoji',
      arguments: { name: 'rocketcli' },
    })) as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };

    const image = res.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data!, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]));
    const meta = JSON.parse(res.content.find((c) => c.type === 'text')!.text!);
    expect(meta).toEqual({ name: 'rocketcli', aliases: ['rkt'] });
  });

  it('get_custom_emoji returns text-only info when image caching is disabled', async () => {
    db = openDb(':memory:');
    rc = new FakeRc();
    const app = makeApp(db, rc, { emojiImages: false });
    db.upsertEmojis([
      { id: 'e1', name: 'rocketcli', aliases: JSON.stringify(['rkt']), extension: 'png', updated_at: null },
    ]);
    db.setMeta('emojis_refreshed_at', new Date().toISOString());
    client = await connect(app);

    const res = (await client.callTool({
      name: 'get_custom_emoji',
      arguments: { name: 'rocketcli' },
    })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };

    expect(res.isError).not.toBe(true);
    expect(res.content.some((c) => c.type === 'image')).toBe(false);
    const meta = JSON.parse(res.content.find((c) => c.type === 'text')!.text!);
    expect(meta.name).toBe('rocketcli');
    expect(meta.aliases).toEqual(['rkt']);
    expect(meta.imageUrl).toContain('/emoji-custom/rocketcli.png');
    expect(meta.note).toMatch(/disabled/i);
  });

  it('disabled mode: refresh stores metadata with zero image fetches', async () => {
    db = openDb(':memory:');
    rc = new FakeRc().onCustomEmojis({
      emojis: { update: [{ _id: 'e1', name: 'a', aliases: [], extension: 'png' }], remove: [] },
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const app = makeApp(db, rc, { emojiImages: false });

    await app.emojis.refresh();
    expect(db.getEmojiImage('e1')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
