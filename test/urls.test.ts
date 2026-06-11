import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb, type Db } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';
import {
  extractMessageId,
  looksLikeUrl,
  parseRocketChatUrl,
} from '../src/core/urls.js';
import { registerOpenUrlTool } from '../src/mcp/tools/open-url.js';
import { registerGetThreadMessagesTool } from '../src/mcp/tools/get-thread-messages.js';
import { registerAddReactionTool } from '../src/mcp/tools/add-reaction.js';

const BASE = 'http://example.com';

// ---------------------------------------------------------------------------
// parseRocketChatUrl / extractMessageId / looksLikeUrl
// ---------------------------------------------------------------------------

describe('parseRocketChatUrl', () => {
  it('parses a channel link', () => {
    expect(parseRocketChatUrl(BASE, `${BASE}/channel/general`)).toEqual({
      kind: 'channel',
      roomRef: 'general',
    });
  });

  it('parses a group link', () => {
    expect(parseRocketChatUrl(BASE, `${BASE}/group/secret`)).toEqual({
      kind: 'group',
      roomRef: 'secret',
    });
  });

  it('parses a direct link (roomRef is the rid)', () => {
    expect(parseRocketChatUrl(BASE, `${BASE}/direct/aBcRid123`)).toEqual({
      kind: 'direct',
      roomRef: 'aBcRid123',
    });
  });

  it('extracts the ?msg= message id', () => {
    expect(parseRocketChatUrl(BASE, `${BASE}/channel/general?msg=MSG1`)).toEqual({
      kind: 'channel',
      roomRef: 'general',
      messageId: 'MSG1',
    });
  });

  it('URL-decodes the room name segment', () => {
    expect(
      parseRocketChatUrl(BASE, `${BASE}/channel/eng%20team?msg=MSG1`),
    ).toEqual({ kind: 'channel', roomRef: 'eng team', messageId: 'MSG1' });
  });

  it('parses the /thread/<tmid> path variant', () => {
    // Modern in-app thread navigation: /channel/:name/:tab?/:context? with
    // tab='thread' and context=tmid (apps/meteor lib/rooms/roomTypes + the
    // useGoToThreadList hook). roomRef is the channel name, messageId the tmid.
    expect(
      parseRocketChatUrl(BASE, `${BASE}/channel/general/thread/TMID9`),
    ).toEqual({ kind: 'channel', roomRef: 'general', messageId: 'TMID9' });
  });

  it('prefers ?msg= over the /thread/ segment when both present', () => {
    expect(
      parseRocketChatUrl(BASE, `${BASE}/channel/general/thread/TMID9?msg=MSG1`),
    ).toEqual({ kind: 'channel', roomRef: 'general', messageId: 'MSG1' });
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(
      parseRocketChatUrl(`${BASE}/`, `${BASE}/channel/general?msg=MSG1`),
    ).toEqual({ kind: 'channel', roomRef: 'general', messageId: 'MSG1' });
  });

  it('tolerates an http/https scheme mismatch on the same host', () => {
    expect(
      parseRocketChatUrl('https://example.com', `${BASE}/channel/general`),
    ).toEqual({ kind: 'channel', roomRef: 'general' });
  });

  it('returns null for a different host', () => {
    expect(
      parseRocketChatUrl(BASE, 'http://evil.test/channel/general'),
    ).toBeNull();
  });

  it('returns null for a non-room path', () => {
    expect(parseRocketChatUrl(BASE, `${BASE}/admin/settings`)).toBeNull();
    expect(parseRocketChatUrl(BASE, `${BASE}/channel`)).toBeNull();
  });

  it('returns null for non-URL input', () => {
    expect(parseRocketChatUrl(BASE, '#general')).toBeNull();
    expect(parseRocketChatUrl(BASE, 'general')).toBeNull();
  });
});

describe('extractMessageId', () => {
  it('reads the ?msg= param', () => {
    expect(extractMessageId(BASE, `${BASE}/channel/general?msg=MSG1`)).toBe(
      'MSG1',
    );
  });

  it('reads the /thread/ segment', () => {
    expect(extractMessageId(BASE, `${BASE}/group/secret/thread/TMID9`)).toBe(
      'TMID9',
    );
  });

  it('returns null when there is no message component', () => {
    expect(extractMessageId(BASE, `${BASE}/channel/general`)).toBeNull();
  });

  it('returns null for a non-RC URL', () => {
    expect(extractMessageId(BASE, 'http://evil.test/x?msg=MSG1')).toBeNull();
  });
});

describe('looksLikeUrl', () => {
  it('true for http(s) URLs', () => {
    expect(looksLikeUrl('http://x.test')).toBe(true);
    expect(looksLikeUrl('https://x.test/a')).toBe(true);
  });
  it('false for room refs', () => {
    expect(looksLikeUrl('#general')).toBe(false);
    expect(looksLikeUrl('@bob')).toBe(false);
    expect(looksLikeUrl('general')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RoomDirectory.resolve with URL input
// ---------------------------------------------------------------------------

/** Minimal fake RcClient mirroring test/rooms.test.ts for the resolve tests. */
class FakeRcRooms {
  private queue: unknown[] = [];
  on(...responses: unknown[]): this {
    this.queue = responses;
    return this;
  }
  getSubscriptions(): Promise<any> {
    if (this.queue.length === 0) {
      throw new Error('FakeRcRooms: no response queued');
    }
    const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];
    return Promise.resolve(next);
  }
}

function sub(over: Partial<RcSubscription>): RcSubscription {
  return { rid: 'r', name: 'name', fname: 'fname', t: 'c', unread: 0, ...over };
}

describe('RoomDirectory.resolve with URL input', () => {
  let db: Db;
  afterEach(() => db?.close());

  function setup(subs: RcSubscription[]): RoomDirectory {
    db = openDb(':memory:');
    const rc = new FakeRcRooms().on({ update: subs, remove: [] });
    return new RoomDirectory(db, rc as never, BASE);
  }

  it('resolves a channel link to its room by name', async () => {
    const dir = setup([sub({ rid: 'C1', name: 'general', t: 'c' })]);
    await dir.refresh();
    const room = await dir.resolve(`${BASE}/channel/general?msg=MSG1`);
    expect(room.rid).toBe('C1');
  });

  it('resolves a direct link by rid', async () => {
    const dir = setup([sub({ rid: 'D1', name: 'bob', t: 'd' })]);
    await dir.refresh();
    const room = await dir.resolve(`${BASE}/direct/D1`);
    expect(room.rid).toBe('D1');
  });

  it('rejects a URL on a different server with a clear error', async () => {
    const dir = setup([sub({ rid: 'C1', name: 'general' })]);
    await dir.refresh();
    await expect(
      dir.resolve('http://evil.test/channel/general'),
    ).rejects.toThrow(/not on configured server/i);
  });

  it('leaves non-URL input unchanged', async () => {
    const dir = setup([sub({ rid: 'C1', name: 'general' })]);
    await dir.refresh();
    expect((await dir.resolve('#general')).rid).toBe('C1');
  });
});

// ---------------------------------------------------------------------------
// MCP tools: open_url flow + URL-acceptance on get_thread_messages/add_reaction
// ---------------------------------------------------------------------------

/**
 * Fake RcClient for the MCP tool tests. Empty defaults everywhere so sync/rooms
 * never blow up; scenarios override specific methods. Records react() calls.
 */
class FakeRc {
  reacts: Array<{ body: Record<string, unknown> }> = [];
  private subscriptions: unknown = { update: [], remove: [] };
  private history: unknown = { messages: [] };
  private threadMessages: unknown = { messages: [], total: 0 };
  private messageById = new Map<string, unknown>();

  onSubscriptions(r: unknown): this {
    this.subscriptions = r;
    return this;
  }
  onHistory(r: unknown): this {
    this.history = r;
    return this;
  }
  onThreadMessages(r: unknown): this {
    this.threadMessages = r;
    return this;
  }
  onMessage(id: string, message: unknown): this {
    this.messageById.set(id, message);
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
  async getMessage(params: { msgId: string }): Promise<any> {
    return { message: this.messageById.get(params.msgId) ?? {} };
  }
  async react(body: Record<string, unknown>): Promise<any> {
    this.reacts.push({ body });
    return { success: true };
  }
}

function makeApp(db: Db, rc: FakeRc): App {
  const rooms = new RoomDirectory(db, rc as never, BASE);
  const emojis = new EmojiDirectory(
    db,
    rc as never,
    { url: BASE, token: 'tok', userId: 'uid' },
    true,
  );
  const sync = new SyncEngine(db, rc as never, rooms, {
    ttlSeconds: 60,
    backfillLimit: 100,
  });
  const search = new SearchService(db, rc as never, sync, BASE);
  const config = {
    url: BASE,
    token: 'tok',
    userId: 'uid',
    dbPath: ':memory:',
    ttlSeconds: 60,
    backfillLimit: 100,
    emojiImages: true,
    readOnly: false,
  };
  return { config, db, rc: rc as never, rooms, emojis, sync, search };
}

/** Connect an in-memory client to a server with ONLY the given tools. */
async function connect(
  app: App,
  register: (server: McpServer, app: App) => void,
): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  register(server, app);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

function resultJson(res: unknown): any {
  const r = res as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0]!.text);
}

function row(over: Record<string, unknown>): any {
  return {
    id: 'x',
    rid: 'C1',
    author_id: 'u1',
    author_username: 'alice',
    author_name: 'Alice',
    text: 'text',
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

describe('open_url tool', () => {
  let db: Db;
  let rc: FakeRc;
  let app: App;
  let client: Client | undefined;

  beforeEach(() => {
    db = openDb(':memory:');
    rc = new FakeRc();
    app = makeApp(db, rc);
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    db.close();
  });

  function seedRoomSynced(): void {
    db.upsertRoom({
      rid: 'C1',
      name: 'general',
      fname: 'General',
      t: 'c',
      unread: 0,
      sub_updated_at: null,
    });
    db.setRoomSyncState('C1', { lastSyncedAt: new Date().toISOString() });
  }

  it('message mode: returns the target plus surrounding timeline + affordances', async () => {
    seedRoomSynced();
    db.upsertMessages([
      row({ id: 'm1', text: 'first', ts: '2026-06-10T00:01:00.000Z' }),
      row({ id: 'm2', text: 'target', ts: '2026-06-10T00:02:00.000Z' }),
      row({ id: 'm3', text: 'third', ts: '2026-06-10T00:03:00.000Z' }),
    ]);
    client = await connect(app, registerOpenUrlTool);

    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: `${BASE}/channel/general?msg=m2`, count: 10 },
    });
    const p = resultJson(res);

    expect(p.mode).toBe('message');
    expect(p.room).toEqual({ id: 'C1', name: 'general', type: 'channel' });
    expect(p.target.id).toBe('m2');
    // Chronological, target in the middle.
    expect(p.messages.map((m: any) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(p.affordances.reactTo).toBe('m2');
    expect(p.affordances.room).toBe('general');
    expect(p.affordances.replyInThread).toBeUndefined();
  });

  it('thread mode: a thread-parent link returns the full thread', async () => {
    seedRoomSynced();
    db.upsertMessages([
      row({
        id: 'P',
        text: 'parent',
        ts: '2026-06-10T00:00:00.000Z',
        tcount: 2,
        tlm: '2026-06-10T00:03:00.000Z',
      }),
    ]);
    rc.onThreadMessages({
      total: 2,
      messages: [
        { _id: 'r1', rid: 'C1', msg: 'reply one', ts: '2026-06-10T00:01:00.000Z', tmid: 'P', u: { _id: 'u2', username: 'bob' } },
        { _id: 'r2', rid: 'C1', msg: 'reply two', ts: '2026-06-10T00:02:00.000Z', tmid: 'P', u: { _id: 'u3', username: 'carol' } },
      ],
    });
    client = await connect(app, registerOpenUrlTool);

    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: `${BASE}/channel/general?msg=P` },
    });
    const p = resultJson(res);

    expect(p.mode).toBe('thread');
    expect(p.target.id).toBe('P');
    expect(p.messages.map((m: any) => m.id)).toEqual(['P', 'r1', 'r2']);
    expect(p.affordances.replyInThread).toBe('P');
    expect(p.affordances.reactTo).toBe('P');
  });

  it('thread mode: a /thread/<tmid> path link opens that thread', async () => {
    seedRoomSynced();
    db.upsertMessages([
      row({ id: 'P', text: 'parent', tcount: 1, tlm: '2026-06-10T00:02:00.000Z' }),
    ]);
    rc.onThreadMessages({
      total: 1,
      messages: [
        { _id: 'r1', rid: 'C1', msg: 'a reply', ts: '2026-06-10T00:02:00.000Z', tmid: 'P', u: { _id: 'u2', username: 'bob' } },
      ],
    });
    client = await connect(app, registerOpenUrlTool);

    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: `${BASE}/channel/general/thread/P` },
    });
    const p = resultJson(res);

    expect(p.mode).toBe('thread');
    expect(p.affordances.replyInThread).toBe('P');
  });

  it('room mode: a bare channel link returns recent timeline', async () => {
    seedRoomSynced();
    db.upsertMessages([
      row({ id: 'm1', text: 'first', ts: '2026-06-10T00:01:00.000Z' }),
      row({ id: 'm2', text: 'second', ts: '2026-06-10T00:02:00.000Z' }),
    ]);
    client = await connect(app, registerOpenUrlTool);

    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: `${BASE}/channel/general` },
    });
    const p = resultJson(res);

    expect(p.mode).toBe('room');
    expect(p.target).toBeUndefined();
    expect(p.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    expect(p.affordances.room).toBe('general');
    expect(p.affordances.reactTo).toBeUndefined();
  });

  it('falls back to chat.getMessage when the target is not cached', async () => {
    seedRoomSynced();
    rc.onMessage('remote1', {
      _id: 'remote1',
      rid: 'C1',
      msg: 'fetched from server',
      ts: '2026-06-10T00:05:00.000Z',
      u: { _id: 'u9', username: 'zoe' },
    });
    client = await connect(app, registerOpenUrlTool);

    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: `${BASE}/channel/general?msg=remote1` },
    });
    const p = resultJson(res);

    expect(p.mode).toBe('message');
    expect(p.target.id).toBe('remote1');
    expect(p.target.text).toBe('fetched from server');
    // Upserted, so it is now local.
    expect(db.getMessage('remote1')?.text).toBe('fetched from server');
  });

  it('errors on a non-URL input listing the accepted shapes', async () => {
    client = await connect(app, registerOpenUrlTool);
    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: '#general' },
    });
    expect((res as any).isError).toBe(true);
  });

  it('errors on a URL from a different server', async () => {
    client = await connect(app, registerOpenUrlTool);
    const res = await client.callTool({
      name: 'open_url',
      arguments: { url: 'http://evil.test/channel/general?msg=m1' },
    });
    expect((res as any).isError).toBe(true);
  });
});

describe('get_thread_messages URL acceptance', () => {
  let db: Db;
  let rc: FakeRc;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    db.close();
  });

  it('accepts a pasted message link and resolves to the tmid', async () => {
    db = openDb(':memory:');
    rc = new FakeRc();
    const app = makeApp(db, rc);
    db.upsertRoom({ rid: 'C1', name: 'general', fname: 'General', t: 'c', unread: 0, sub_updated_at: null });
    db.setRoomSyncState('C1', { lastSyncedAt: new Date().toISOString() });
    db.upsertMessages([
      row({ id: 'P', text: 'parent', tcount: 1, tlm: '2026-06-10T00:02:00.000Z' }),
    ]);
    rc.onThreadMessages({
      total: 1,
      messages: [
        { _id: 'r1', rid: 'C1', msg: 'reply', ts: '2026-06-10T00:02:00.000Z', tmid: 'P', u: { _id: 'u2', username: 'bob' } },
      ],
    });
    client = await connect(app, registerGetThreadMessagesTool);

    const res = await client.callTool({
      name: 'get_thread_messages',
      arguments: { threadId: `${BASE}/channel/general?msg=P` },
    });
    const p = resultJson(res);
    expect(p.parent.id).toBe('P');
    expect(p.messages.map((m: any) => m.id)).toEqual(['r1']);
  });
});

describe('add_reaction URL acceptance', () => {
  let db: Db;
  let rc: FakeRc;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    db.close();
  });

  it('extracts the message id from a pasted link before reacting', async () => {
    db = openDb(':memory:');
    rc = new FakeRc();
    const app = makeApp(db, rc);
    client = await connect(app, registerAddReactionTool);

    const res = await client.callTool({
      name: 'add_reaction',
      arguments: { messageId: `${BASE}/channel/general?msg=MSG42`, emoji: 'thumbsup' },
    });
    const p = resultJson(res);
    expect(p.reacted).toBe(true);
    expect(p.messageId).toBe('MSG42');
    expect(rc.reacts[0]!.body['messageId']).toBe('MSG42');
    expect(rc.reacts[0]!.body['emoji']).toBe(':thumbsup:');
  });
});
