import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { MessageRow } from '../src/core/types.js';
import { registerGetMessageContextTool } from '../src/mcp/tools/get-message-context.js';

/**
 * Minimal recording fake RcClient. getMessage is overridable per-test so the
 * "missing locally" fetch path can be exercised; everything else returns benign
 * empties so sync paths never throw.
 */
class RecordingRc {
  calls: string[] = [];
  private getMessageResponse: unknown = { message: {} };

  onGetMessage(response: unknown): this {
    this.getMessageResponse = response;
    return this;
  }

  async getSubscriptions(): Promise<any> {
    this.calls.push('getSubscriptions');
    return { update: [], remove: [] };
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
  async getMessage(): Promise<any> {
    this.calls.push('getMessage');
    return this.getMessageResponse;
  }
  async listCustomEmojis(): Promise<any> {
    this.calls.push('listCustomEmojis');
    return { emojis: { update: [], remove: [] } };
  }
}

function makeApp(db: Db, rc: RecordingRc): App {
  const rooms = new RoomDirectory(db, rc as never);
  const emojis = new EmojiDirectory(
    db,
    rc as never,
    { url: 'http://example.com', token: 'tok', userId: 'uid' },
    true,
  );
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

function seedRoom(db: Db, rid: string, t = 'c'): void {
  db.upsertRoom({ rid, name: rid === 'C1' ? 'general' : rid, fname: rid, t, unread: 0, sub_updated_at: null });
  db.setRoomSyncState(rid, { lastSyncedAt: new Date().toISOString() });
}

function msg(over: Partial<MessageRow> & Pick<MessageRow, 'id' | 'rid' | 'ts'>): MessageRow {
  return {
    author_id: 'u1',
    author_username: 'alice',
    author_name: 'Alice',
    text: 'text',
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

/**
 * Capture-only McpServer stand-in: records the single registered tool and lets
 * the test invoke its handler directly, then parses the JSON envelope.
 */
class FakeServer {
  handler!: (args: any) => Promise<any>;
  registerTool(_name: string, _def: unknown, handler: (args: any) => Promise<any>): void {
    this.handler = handler;
  }
}

async function callTool(app: App, args: Record<string, unknown>): Promise<any> {
  const server = new FakeServer();
  registerGetMessageContextTool(server as never, app);
  const res = await server.handler(args);
  return res;
}

function payloadOf(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe('get_message_context', () => {
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

  it('timeline mode: slices before/after around the target, target in place, not duplicated', async () => {
    seedRoom(db, 'C1');
    // 7 messages t1..t7; target = t4. before=2, after=2 -> [t2,t3,t4,t5,t6].
    db.upsertMessages([
      msg({ id: 't1', rid: 'C1', ts: '2026-06-10T10:01:00.000Z', text: 'one' }),
      msg({ id: 't2', rid: 'C1', ts: '2026-06-10T10:02:00.000Z', text: 'two' }),
      msg({ id: 't3', rid: 'C1', ts: '2026-06-10T10:03:00.000Z', text: 'three' }),
      msg({ id: 't4', rid: 'C1', ts: '2026-06-10T10:04:00.000Z', text: 'four' }),
      msg({ id: 't5', rid: 'C1', ts: '2026-06-10T10:05:00.000Z', text: 'five' }),
      msg({ id: 't6', rid: 'C1', ts: '2026-06-10T10:06:00.000Z', text: 'six' }),
      msg({ id: 't7', rid: 'C1', ts: '2026-06-10T10:07:00.000Z', text: 'seven' }),
    ]);

    const p = payloadOf(await callTool(app, { messageId: 't4', before: 2, after: 2 }));

    expect(p.mode).toBe('timeline');
    expect(p.target.id).toBe('t4');
    expect(p.messages.map((m: any) => m.id)).toEqual(['t2', 't3', 't4', 't5', 't6']);
    // Target appears exactly once.
    expect(p.messages.filter((m: any) => m.id === 't4')).toHaveLength(1);
    // Chronological.
    const times = p.messages.map((m: any) => m.time);
    expect([...times].sort()).toEqual(times);
  });

  it('timeline mode: respects before/after counts at the head of the timeline', async () => {
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg({ id: 'a', rid: 'C1', ts: '2026-06-10T10:01:00.000Z' }),
      msg({ id: 'b', rid: 'C1', ts: '2026-06-10T10:02:00.000Z' }),
      msg({ id: 'c', rid: 'C1', ts: '2026-06-10T10:03:00.000Z' }),
    ]);

    const p = payloadOf(await callTool(app, { messageId: 'a', before: 10, after: 1 }));
    // Nothing before the first message; one after.
    expect(p.messages.map((m: any) => m.id)).toEqual(['a', 'b']);
  });

  it('every message carries a permalink', async () => {
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg({ id: 'x', rid: 'C1', ts: '2026-06-10T10:01:00.000Z' }),
      msg({ id: 'y', rid: 'C1', ts: '2026-06-10T10:02:00.000Z' }),
    ]);

    const p = payloadOf(await callTool(app, { messageId: 'x', before: 1, after: 1 }));
    expect(p.target.link).toBe('http://example.com/channel/general?msg=x');
    expect(p.messages.map((m: any) => m.link)).toEqual([
      'http://example.com/channel/general?msg=x',
      'http://example.com/channel/general?msg=y',
    ]);
  });

  it('thread-reply pivots to its whole thread, sliced around the target', async () => {
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg({ id: 'P', rid: 'C1', ts: '2026-06-10T10:00:00.000Z', tcount: 4, tlm: '2026-06-10T10:40:00.000Z', text: 'parent' }),
      msg({ id: 'r1', rid: 'C1', ts: '2026-06-10T10:10:00.000Z', tmid: 'P', text: 'r1' }),
      msg({ id: 'r2', rid: 'C1', ts: '2026-06-10T10:20:00.000Z', tmid: 'P', text: 'r2' }),
      msg({ id: 'r3', rid: 'C1', ts: '2026-06-10T10:30:00.000Z', tmid: 'P', text: 'r3' }),
      msg({ id: 'r4', rid: 'C1', ts: '2026-06-10T10:40:00.000Z', tmid: 'P', text: 'r4' }),
    ]);
    // tcount(4) == local reply count(4) so ensureThreadLoaded does no fetch.
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });

    const p = payloadOf(await callTool(app, { messageId: 'r3', before: 1, after: 1 }));
    expect(p.mode).toBe('thread');
    expect(p.target.id).toBe('r3');
    // 1 before, target, 1 after -> r2, r3, r4.
    expect(p.messages.map((m: any) => m.id)).toEqual(['r2', 'r3', 'r4']);
  });

  it('thread-parent returns thread mode with parent + first replies', async () => {
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg({ id: 'P', rid: 'C1', ts: '2026-06-10T10:00:00.000Z', tcount: 3, tlm: '2026-06-10T10:30:00.000Z', text: 'parent' }),
      msg({ id: 'r1', rid: 'C1', ts: '2026-06-10T10:10:00.000Z', tmid: 'P', text: 'r1' }),
      msg({ id: 'r2', rid: 'C1', ts: '2026-06-10T10:20:00.000Z', tmid: 'P', text: 'r2' }),
      msg({ id: 'r3', rid: 'C1', ts: '2026-06-10T10:30:00.000Z', tmid: 'P', text: 'r3' }),
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });

    const p = payloadOf(await callTool(app, { messageId: 'P', before: 1, after: 1 }));
    expect(p.mode).toBe('thread');
    expect(p.target.id).toBe('P');
    expect(p.target.replyCount).toBe(3);
    // parent + first (before+after = 2) replies.
    expect(p.messages.map((m: any) => m.id)).toEqual(['P', 'r1', 'r2']);
  });

  it('missing locally: fetches via rc.getMessage and upserts', async () => {
    seedRoom(db, 'C1');
    db.upsertMessages([
      msg({ id: 'near', rid: 'C1', ts: '2026-06-10T10:00:00.000Z', text: 'neighbor' }),
    ]);
    rc.onGetMessage({
      message: {
        _id: 'fetched',
        rid: 'C1',
        msg: 'fetched from server',
        ts: '2026-06-10T10:01:00.000Z',
        u: { _id: 'u9', username: 'zoe', name: 'Zoe' },
      },
    });

    const p = payloadOf(await callTool(app, { messageId: 'fetched', before: 5, after: 5 }));
    expect(rc.calls).toContain('getMessage');
    expect(p.target.id).toBe('fetched');
    expect(p.target.text).toBe('fetched from server');
    // Now persisted in the cache.
    expect(db.getMessage('fetched')?.text).toBe('fetched from server');
  });

  it('totally unknown id: clean error envelope', async () => {
    rc.onGetMessage({ message: {} }); // no _id

    const res = await callTool(app, { messageId: 'ghost', before: 5, after: 5 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});
