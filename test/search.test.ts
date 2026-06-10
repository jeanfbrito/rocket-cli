import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db, type MessageRow, type RoomRow } from '../src/core/db.js';
import {
  SearchService,
  sanitizeFtsQuery,
  type SyncLike,
} from '../src/core/search.js';
import { RcApiError } from '../src/core/errors.js';
import type { RcClient, SearchMessagesResult } from '../src/core/rc-client.js';
import type { RcMessage } from '../src/core/normalize.js';

// ---- fixtures --------------------------------------------------------------

function room(rid: string, over: Partial<RoomRow> = {}): RoomRow {
  return {
    rid,
    name: rid,
    fname: rid,
    t: 'c',
    unread: 0,
    last_synced_at: null,
    oldest_loaded_ts: null,
    fully_backfilled: 0,
    sub_updated_at: null,
    ...over,
  };
}

function msg(id: string, over: Partial<MessageRow> = {}): MessageRow {
  return {
    id,
    rid: 'r1',
    author_id: 'u1',
    author_username: 'alice',
    author_name: 'Alice',
    text: 'hello',
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

/** Fake sync that records ensureRoomSynced calls. */
function fakeSync(): SyncLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async ensureRoomSynced(rid: string): Promise<void> {
      calls.push(rid);
    },
  };
}

/**
 * Fake RcClient: `searchMessages` returns a queued response or throws a queued
 * error. Only `searchMessages` is exercised by SearchService.
 */
function fakeRc(impl?: (params: { roomId: string; searchText: string; count?: number }) => unknown): {
  rc: RcClient;
  searchMessages: ReturnType<typeof vi.fn>;
} {
  const searchMessages = vi.fn(
    async (params: { roomId: string; searchText: string; count?: number }) => {
      if (impl) return impl(params) as SearchMessagesResult;
      return { messages: [] } as unknown as SearchMessagesResult;
    },
  );
  const rc = { searchMessages } as unknown as RcClient;
  return { rc, searchMessages };
}

function serverMsg(id: string, msgText: string, over: Partial<RcMessage> = {}): RcMessage {
  return {
    _id: id,
    rid: 'r1',
    msg: msgText,
    ts: '2026-06-09T00:00:00.000Z',
    u: { _id: 'u9', username: 'bob', name: 'Bob' },
    ...over,
  };
}

// ---- sanitizeFtsQuery ------------------------------------------------------

describe('sanitizeFtsQuery', () => {
  it('quotes plain words and joins with implicit AND', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('"hello" "world"');
  });

  it('strips embedded double quotes from tokens', () => {
    expect(sanitizeFtsQuery('say "hi"')).toBe('"say" "hi"');
  });

  it('preserves a trailing * as a prefix query', () => {
    expect(sanitizeFtsQuery('foo*')).toBe('"foo"*');
    expect(sanitizeFtsQuery('deploy* now')).toBe('"deploy"* "now"');
  });

  it('neutralizes FTS5 operators (NEAR, -, parens) as literals', () => {
    // Each becomes a quoted literal, so none act as an operator.
    expect(sanitizeFtsQuery('NEAR')).toBe('"NEAR"');
    expect(sanitizeFtsQuery('-foo')).toBe('"-foo"');
    expect(sanitizeFtsQuery('(bar)')).toBe('"(bar)"');
    expect(sanitizeFtsQuery('a AND b')).toBe('"a" "AND" "b"');
  });

  it('throws on empty / quote-only input', () => {
    expect(() => sanitizeFtsQuery('')).toThrow('empty search query');
    expect(() => sanitizeFtsQuery('   ')).toThrow('empty search query');
    expect(() => sanitizeFtsQuery('""')).toThrow('empty search query');
  });
});

// ---- SearchService ---------------------------------------------------------

describe('SearchService.search', () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  function seedRoom(): void {
    db.upsertRoom(room('r1'));
  }

  it('returns local hits with «»-marked snippets', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([
      msg('m1', { text: 'the deployment pipeline broke today' }),
      msg('m2', { text: 'unrelated chatter about lunch' }),
    ]);

    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('deployment', { room: room('r1') });

    const ids = res.results.map((r) => r.id);
    expect(ids).toContain('m1');
    expect(ids).not.toContain('m2');
    const hit = res.results.find((r) => r.id === 'm1')!;
    expect(hit.snippet).toContain('«');
    expect(hit.snippet).toContain('»');
    expect(hit.roomId).toBe('r1');
    expect(hit.source).toBe('local');
  });

  it('ranks an exact-phrase match above a weak single-term match (bm25 asc)', async () => {
    db = openDb(':memory:');
    seedRoom();
    // Doc with both query terms should outrank doc with only one.
    db.upsertMessages([
      msg('strong', { text: 'database migration migration migration plan' }),
      msg('weak', { text: 'migration of furniture across the office' }),
    ]);

    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('database migration', { room: room('r1'), limit: 20 });

    expect(res.results[0]?.id).toBe('strong');
  });

  it('excludes soft-deleted messages (deleted=1)', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([
      msg('live', { text: 'visible token' }),
      msg('gone', { text: 'visible token' }),
    ]);
    db.markMessagesDeleted(['gone']);

    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('visible', { room: room('r1') });
    expect(res.results.map((r) => r.id)).toEqual(['live']);
  });

  it('narrows by room filter', async () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertRoom(room('r2'));
    db.upsertMessages([
      msg('a', { rid: 'r1', text: 'shared keyword' }),
      msg('b', { rid: 'r2', text: 'shared keyword' }),
    ]);

    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('shared', { room: room('r1') });
    expect(res.results.map((r) => r.id)).toEqual(['a']);
  });

  it('narrows by author filter', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([
      msg('byAlice', { text: 'common term', author_username: 'alice' }),
      msg('byBob', { text: 'common term', author_username: 'bob' }),
    ]);

    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('common', { room: room('r1'), author: 'bob' });
    expect(res.results.map((r) => r.id)).toEqual(['byBob']);
  });

  it('matches across diacritics: "funcao" finds "função"', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([msg('pt', { text: 'Essa função está quebrada' })]);

    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('funcao', { room: room('r1') });
    expect(res.results.map((r) => r.id)).toContain('pt');
  });

  it('hybrid: thin local + room → server fallback ingests, merges, tags source', async () => {
    db = openDb(':memory:');
    seedRoom();
    // One local hit (< THIN_THRESHOLD of 5) triggers fallback.
    db.upsertMessages([msg('local1', { text: 'incident postmortem notes' })]);

    const { rc, searchMessages } = fakeRc(() => ({
      messages: [
        serverMsg('srv1', 'older incident report'),
        serverMsg('local1', 'incident postmortem notes'), // dup id → not re-added
      ],
    }));
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('incident', { room: room('r1'), limit: 20 });

    // searchMessages called with the ORIGINAL (unsanitized) query.
    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages).toHaveBeenCalledWith({
      roomId: 'r1',
      searchText: 'incident',
      count: 20,
    });

    // Server result upserted into the cache.
    expect(db.getMessage('srv1')).toBeDefined();

    // Local-first ordering, dedup by id, server result tagged.
    expect(res.results.map((r) => r.id)).toEqual(['local1', 'srv1']);
    expect(res.results.find((r) => r.id === 'local1')?.source).toBe('local');
    expect(res.results.find((r) => r.id === 'srv1')?.source).toBe('server');
    expect(res.localOnly).toBe(false);
  });

  it('thin local + NO room → no server call, localOnly with note', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([msg('only', { text: 'lonely match here' })]);

    const { rc, searchMessages } = fakeRc();
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('lonely');

    expect(searchMessages).not.toHaveBeenCalled();
    expect(res.localOnly).toBe(true);
    expect(res.note).toMatch(/pass a room/i);
    expect(res.results.map((r) => r.id)).toEqual(['only']);
  });

  it('server error during fallback → returns local results, note set, no throw', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([msg('local1', { text: 'flaky search term' })]);

    const { rc, searchMessages } = fakeRc(() => {
      throw new RcApiError('boom', 500);
    });
    const svc = new SearchService(db, rc, fakeSync());
    const res = await svc.search('flaky', { room: room('r1') });

    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(res.results.map((r) => r.id)).toEqual(['local1']);
    expect(res.localOnly).toBe(true);
    expect(res.note).toMatch(/server search unavailable/i);
  });

  it('calls ensureRoomSynced when a room is passed', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([msg('m1', { text: 'syncme content' })]);

    const sync = fakeSync();
    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, sync);
    await svc.search('syncme', { room: room('r1') });
    expect(sync.calls).toEqual(['r1']);
  });

  it('does NOT call ensureRoomSynced when no room is passed', async () => {
    db = openDb(':memory:');
    seedRoom();
    db.upsertMessages([msg('m1', { text: 'syncme content' })]);

    const sync = fakeSync();
    const { rc } = fakeRc();
    const svc = new SearchService(db, rc, sync);
    await svc.search('syncme');
    expect(sync.calls).toEqual([]);
  });
});
