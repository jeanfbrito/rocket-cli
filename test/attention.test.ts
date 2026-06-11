import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db, type MessageRow } from '../src/core/db.js';
import type { App } from '../src/core/app.js';
import { RoomDirectory } from '../src/core/rooms.js';
import { EmojiDirectory } from '../src/core/emojis.js';
import { SyncEngine } from '../src/core/sync.js';
import { SearchService } from '../src/core/search.js';
import type { RcSubscription } from '../src/core/normalize.js';
import { collectAttention } from '../src/core/attention.js';

/**
 * Recording fake RcClient. userInfo resolves the username ('jean'); every other
 * method returns benign empty defaults so the read-only sync paths never blow
 * up. postMessage/react throw — the attention view must never mutate anything.
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
    throw new Error('postMessage must never be called by the attention view');
  }
  async react(): Promise<any> {
    this.calls.push('react');
    throw new Error('react must never be called by the attention view');
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

/** Seed a room (synced, so ensureRoomSynced no-ops) with a watermark. */
function seedRoom(
  db: Db,
  rid: string,
  over: Partial<{ unread: number; t: string; ls: string; tunread: string }> = {},
): void {
  db.upsertRoom({
    rid,
    name: rid,
    fname: rid,
    t: over.t ?? 'c',
    unread: over.unread ?? 0,
    sub_updated_at: null,
  });
  db.setRoomSyncState(rid, { lastSyncedAt: new Date().toISOString() });
}

function msg(id: string, rid: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    rid,
    author_id: 'u1',
    author_username: 'alice',
    author_name: 'Alice',
    text: `msg ${id}`,
    ts: '2026-06-10T13:00:00.000Z',
    tmid: null,
    tcount: null,
    tlm: null,
    edited_at: null,
    system_type: null,
    attachments_json: null,
    deleted: 0,
    updated_at: null,
    mentions: '[]',
    ...over,
  };
}

const LS = '2026-06-10T12:00:00.000Z';

describe('collectAttention', () => {
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

  it('returns an empty digest with zero totals when nothing is pending', async () => {
    rc.onSubscriptions({ update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 0 })], remove: [] });
    seedRoom(db, 'C1');

    const report = await collectAttention(app, { sinceDays: 30 });

    expect(report.mentions).toEqual([]);
    expect(report.directUnreads).toEqual([]);
    expect(report.threadUnreads).toEqual([]);
    expect(report.channelUnreads).toEqual([]);
    expect(report.totals).toEqual({
      mentions: 0,
      directUnreads: 0,
      threadUnreads: 0,
      channelUnreads: 0,
      all: 0,
    });
    expect(typeof report.searchedSince).toBe('string');
    expect(typeof report.generatedAt).toBe('string');
    // Pure read: never mutated anything.
    expect(rc.calls).not.toContain('postMessage');
    expect(rc.calls).not.toContain('react');
  });

  it('sections by source and routes DMs vs channels correctly', async () => {
    rc.onSubscriptions({
      update: [
        sub({ rid: 'C1', name: 'general', t: 'c', unread: 1, ls: LS }),
        sub({ rid: 'D1', name: 'rocket.cat', t: 'd', unread: 1, ls: LS }),
      ],
      remove: [],
    });
    seedRoom(db, 'C1', { unread: 1, ls: LS });
    seedRoom(db, 'D1', { t: 'd', unread: 1, ls: LS });
    db.upsertMessages([
      msg('cPlain', 'C1', { ts: '2026-06-10T13:10:00.000Z' }),
      msg('dm1', 'D1', { ts: '2026-06-10T13:20:00.000Z' }),
    ]);

    const report = await collectAttention(app, { sinceDays: 30 });

    expect(report.directUnreads.map((i) => i.message.id)).toEqual(['dm1']);
    expect(report.directUnreads[0]!.room.type).toBe('dm');
    expect(report.channelUnreads.map((i) => i.message.id)).toEqual(['cPlain']);
    expect(report.channelUnreads[0]!.room.type).toBe('channel');
  });

  it('dedupes a mentioned-and-unread message into mentions with alsoUnread', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 2, ls: LS })],
      remove: [],
    });
    seedRoom(db, 'C1', { unread: 2, ls: LS });
    db.upsertMessages([
      // Mentions jean AND unread (ts > ls) -> mentions only, alsoUnread.
      msg('mention', 'C1', { mentions: '["jean"]', ts: '2026-06-10T13:30:00.000Z' }),
      // Plain unread -> channelUnreads.
      msg('plain', 'C1', { ts: '2026-06-10T13:40:00.000Z' }),
    ]);

    const report = await collectAttention(app, { sinceDays: 30 });

    expect(report.mentions.map((i) => i.message.id)).toEqual(['mention']);
    expect(report.mentions[0]!.alsoUnread).toBe(true);

    const channelIds = report.channelUnreads.map((i) => i.message.id);
    expect(channelIds).toContain('plain');
    expect(channelIds).not.toContain('mention');

    // The message is surfaced exactly once across the whole digest.
    const allIds = [
      ...report.mentions,
      ...report.directUnreads,
      ...report.channelUnreads,
    ].map((i) => i.message.id);
    expect(allIds.filter((id) => id === 'mention')).toHaveLength(1);
  });

  it('excludes mentioned thread replies from threadUnreads (dedupe across sections)', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 1, ls: LS, tunread: ['P'] })],
      remove: [],
    });
    seedRoom(db, 'C1', { unread: 1, ls: LS });
    db.upsertMessages([
      msg('P', 'C1', { tcount: 1, tlm: '2026-06-10T13:00:00.000Z', ts: '2026-06-10T10:00:00.000Z' }),
      // Two unread replies: one mentions jean (-> mentions), one does not (-> thread).
      msg('rMine', 'C1', { tmid: 'P', mentions: '["jean"]', ts: '2026-06-10T13:05:00.000Z' }),
      msg('rOther', 'C1', { tmid: 'P', ts: '2026-06-10T13:10:00.000Z' }),
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });

    const report = await collectAttention(app, { sinceDays: 30 });

    expect(report.mentions.map((i) => i.message.id)).toEqual(['rMine']);
    expect(report.threadUnreads).toHaveLength(1);
    expect(report.threadUnreads[0]!.parent.id).toBe('P');
    expect(report.threadUnreads[0]!.messages.map((m) => m.id)).toEqual(['rOther']);
  });

  it('preserves priority ordering of sections and totals', async () => {
    rc.onSubscriptions({
      update: [
        sub({ rid: 'C1', name: 'general', t: 'c', unread: 1, ls: LS, tunread: ['P'] }),
        sub({ rid: 'D1', name: 'rocket.cat', t: 'd', unread: 1, ls: LS }),
      ],
      remove: [],
    });
    seedRoom(db, 'C1', { unread: 1, ls: LS });
    seedRoom(db, 'D1', { t: 'd', unread: 1, ls: LS });
    db.upsertMessages([
      msg('cMention', 'C1', { mentions: '["jean"]', ts: '2026-06-10T13:30:00.000Z' }),
      msg('cPlain', 'C1', { ts: '2026-06-10T13:45:00.000Z' }),
      msg('P', 'C1', { tcount: 1, tlm: '2026-06-10T13:00:00.000Z', ts: '2026-06-10T10:00:00.000Z' }),
      msg('tReply', 'C1', { tmid: 'P', ts: '2026-06-10T13:05:00.000Z' }),
      msg('dm1', 'D1', { ts: '2026-06-10T13:20:00.000Z' }),
    ]);
    db.setThreadSync('P', { lastSyncedAt: new Date().toISOString(), fullyLoaded: true });

    const report = await collectAttention(app, { sinceDays: 30 });

    expect(report.totals).toEqual({
      mentions: 1,
      directUnreads: 1,
      threadUnreads: 1,
      channelUnreads: 1,
      all: 4,
    });
    // mentions highest priority, then DM, then thread, then channel.
    expect(report.mentions[0]!.message.id).toBe('cMention');
    expect(report.directUnreads[0]!.message.id).toBe('dm1');
    expect(report.threadUnreads[0]!.messages[0]!.id).toBe('tReply');
    expect(report.channelUnreads[0]!.message.id).toBe('cPlain');
  });

  it('passes includeChannelWide through to the mentions search', async () => {
    rc.onSubscriptions({
      update: [sub({ rid: 'C1', name: 'general', t: 'c', unread: 0, ls: LS })],
      remove: [],
    });
    seedRoom(db, 'C1', { ls: LS });
    db.upsertMessages([
      msg('wide', 'C1', { mentions: '["all"]', ts: '2026-06-10T11:00:00.000Z' }),
    ]);

    const off = await collectAttention(app, { sinceDays: 30 });
    expect(off.mentions).toEqual([]);

    const on = await collectAttention(app, { sinceDays: 30, includeChannelWide: true });
    expect(on.mentions.map((i) => i.message.id)).toEqual(['wide']);
  });
});
