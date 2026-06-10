import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db, type MessageRow, type RoomRow } from '../src/core/db.js';

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
    alert: 0,
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

/** Raw FTS match helper — returns matched message ids via rowid join. */
function ftsIds(db: Db, query: string): string[] {
  return (
    db.conn
      .prepare(
        `SELECT m.id AS id FROM messages_fts
         JOIN messages m ON m.rowid = messages_fts.rowid
         WHERE messages_fts MATCH ?`,
      )
      .all(query) as { id: string }[]
  ).map((r) => r.id);
}

function ftsRowids(db: Db, query: string): number[] {
  return (
    db.conn
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
      .all(query) as { rowid: number }[]
  ).map((r) => r.rowid);
}

describe('migrations', () => {
  it('migrates a :memory: db cleanly and sets schema_version', () => {
    const db = openDb(':memory:');
    expect(db.getMeta('schema_version')).toBe('6');
    const tables = (
      db.conn
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'meta',
        'rooms',
        'messages',
        'thread_sync',
        'messages_fts',
        'custom_emojis',
      ]),
    );
    db.close();
  });

  it('v4 adds ls + tunread columns to rooms', () => {
    const db = openDb(':memory:');
    expect(db.getMeta('schema_version')).toBe('6');
    const cols = (
      db.conn.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['ls', 'tunread']));
    db.close();
  });

  it('v6 adds an alert column to rooms, defaulting to 0', () => {
    const db = openDb(':memory:');
    expect(db.getMeta('schema_version')).toBe('6');
    const cols = (
      db.conn.prepare('PRAGMA table_info(rooms)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('alert');
    // A room inserted without an explicit alert defaults to 0.
    db.upsertRoom(room('r1', { alert: undefined }));
    expect(db.getRoom('r1')?.alert).toBe(0);
    db.close();
  });

  it('v5 adds a mentions column + partial index, defaulting to []', () => {
    const db = openDb(':memory:');
    expect(db.getMeta('schema_version')).toBe('6');

    const cols = (
      db.conn.prepare('PRAGMA table_info(messages)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain('mentions');

    const indexes = (
      db.conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('idx_messages_mentions');

    // A row inserted without an explicit mentions value defaults to '[]'.
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('m1')]);
    const stored = (
      db.conn.prepare("SELECT mentions FROM messages WHERE id = 'm1'").get() as {
        mentions: string;
      }
    ).mentions;
    expect(stored).toBe('[]');
    db.close();
  });

  it('json_each is available in the better-sqlite3 SQLite build', () => {
    // findMentions relies on the json_each table-valued function; assert the
    // runtime supports it rather than silently falling back to LIKE.
    const db = openDb(':memory:');
    const rows = db.conn
      .prepare(
        `SELECT value FROM json_each('["jean","all"]') WHERE value = 'jean'`,
      )
      .all() as { value: string }[];
    expect(rows.map((r) => r.value)).toEqual(['jean']);
    db.close();
  });

  it('is idempotent: re-opening the same file applies no further migrations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rocket-db-'));
    const path = join(dir, 'cache.db');
    try {
      const db1 = openDb(path);
      db1.setMeta('instance_url', 'https://example.com');
      db1.close();

      const db2 = openDb(path);
      // Still at the latest version, prior data preserved → no destructive re-run.
      expect(db2.getMeta('schema_version')).toBe('6');
      expect(db2.getMeta('instance_url')).toBe('https://example.com');
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('repository', () => {
  let db: Db;

  afterEach(() => {
    db?.close();
  });

  it('upsertMessages is idempotent and updates mutable columns', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));

    db.upsertMessages([msg('m1', { text: 'first version' })]);
    db.upsertMessages([msg('m1', { text: 'second version' })]);

    const count = (
      db.conn.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = 'm1'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
    expect(db.getMessage('m1')?.text).toBe('second version');
  });

  it('FTS matches Portuguese with diacritics folded (remove_diacritics 2)', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('m1', { text: 'Essa função está quebrada' })]);

    expect(ftsRowids(db, 'funcao').length).toBe(1);
    expect(ftsIds(db, 'funcao')).toContain('m1');
  });

  it('soft delete evicts from FTS but keeps the row with deleted=1', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('m1', { text: 'searchable token' })]);
    expect(ftsIds(db, 'searchable')).toContain('m1');

    db.markMessagesDeleted(['m1']);

    expect(ftsIds(db, 'searchable')).toHaveLength(0);
    const row = db.getMessage('m1');
    expect(row).toBeDefined();
    expect(row?.deleted).toBe(1);
  });

  it('edit flow: FTS reflects new text, not old (no orphaned index entry)', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('m1', { text: 'alpha original' })]);
    expect(ftsIds(db, 'alpha')).toContain('m1');

    db.upsertMessages([msg('m1', { text: 'beta replacement' })]);
    expect(ftsIds(db, 'alpha')).toHaveLength(0);
    expect(ftsIds(db, 'beta')).toContain('m1');

    // External-content integrity must hold after the delete+reinsert cycle.
    expect(() => db.conn.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')")).not.toThrow();
  });

  it('identical re-upsert keeps the row searchable (delta sync no-op path)', () => {
    // Regression for the dogfood FTS miss: chat.syncMessages on this server
    // (lastUpdate path, envelope { result: { updated, deleted } } with NO
    // cursor) returns ALL updates in one page, and delta sync re-upserts
    // already-known rows on every sync. The v1 UPDATE triggers fired
    // delete(old)+insert(new) even when content was identical, which corrupts
    // the FTS5 external-content posting list and silently makes the row
    // unsearchable (integrity-check still passes). v2 guards the triggers on
    // content actually changing.
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    // Mirrors the real captured shape: "rocket-cli dogfood: thread parent ...".
    db.upsertMessages([msg('m1', { text: 'rocket-cli dogfood thread parent' })]);
    expect(ftsIds(db, 'dogfood')).toContain('m1');

    // Re-upsert identical content twice (what `sync --force` does repeatedly).
    db.upsertMessages([msg('m1', { text: 'rocket-cli dogfood thread parent' })]);
    db.upsertMessages([msg('m1', { text: 'rocket-cli dogfood thread parent' })]);

    expect(ftsIds(db, 'dogfood')).toContain('m1');
    expect(ftsIds(db, 'parent')).toContain('m1');
    expect(() =>
      db.conn.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')"),
    ).not.toThrow();
  });

  it('updating a non-indexed column does not desync the FTS index', () => {
    // Delta re-upserts also carry tcount/tlm bumps on thread parents. Those
    // columns are not in the FTS index; touching them must not perturb the
    // term posting list for the row's text.
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('p1', { text: 'unique thread parent body', tcount: null })]);
    expect(ftsIds(db, 'unique')).toContain('p1');

    // Same text/author, only tcount/tlm change (the parent gained a reply).
    db.upsertMessages([
      msg('p1', { text: 'unique thread parent body', tcount: 2, tlm: '2026-06-10T16:00:00.000Z' }),
    ]);

    expect(ftsIds(db, 'unique')).toContain('p1');
    expect(db.getMessage('p1')?.tcount).toBe(2);
  });

  it('undelete re-indexes without corrupting external content', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('m1', { text: 'revivable text' })]);
    db.markMessagesDeleted(['m1']);
    expect(ftsIds(db, 'revivable')).toHaveLength(0);

    // Re-upsert with deleted=0 (undelete) — old row was NOT indexed, so the
    // update delete-half must not fire a 'delete' for an unindexed row.
    db.upsertMessages([msg('m1', { text: 'revivable text', deleted: 0 })]);
    expect(ftsIds(db, 'revivable')).toContain('m1');
    expect(() => db.conn.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')")).not.toThrow();
  });

  it('getTimeline respects tmid IS NULL, beforeTs, limit, and system filter', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('top1', { ts: '2026-06-10T01:00:00.000Z' }),
      msg('top2', { ts: '2026-06-10T02:00:00.000Z' }),
      msg('top3', { ts: '2026-06-10T03:00:00.000Z' }),
      msg('reply1', { tmid: 'top1', ts: '2026-06-10T01:30:00.000Z' }),
      msg('sys1', { system_type: 'uj', ts: '2026-06-10T02:30:00.000Z' }),
    ]);

    // Default excludes replies and system messages; newest first.
    const def = db.getTimeline('r1', { limit: 10 });
    expect(def.map((m) => m.id)).toEqual(['top3', 'top2', 'top1']);

    // includeSystem=true brings the system message in.
    const withSys = db.getTimeline('r1', { limit: 10, includeSystem: true });
    expect(withSys.map((m) => m.id)).toContain('sys1');

    // beforeTs filters strictly older.
    const before = db.getTimeline('r1', {
      limit: 10,
      beforeTs: '2026-06-10T03:00:00.000Z',
    });
    expect(before.map((m) => m.id)).toEqual(['top2', 'top1']);

    // limit caps the result set.
    expect(db.getTimeline('r1', { limit: 1 }).map((m) => m.id)).toEqual(['top3']);
  });

  it('countThreadReplies and getThreadParents order by tlm DESC', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('parentA', { tcount: 2, tlm: '2026-06-10T05:00:00.000Z' }),
      msg('parentB', { tcount: 1, tlm: '2026-06-10T09:00:00.000Z' }),
      msg('plain', { tcount: null }),
      msg('rA1', { tmid: 'parentA', ts: '2026-06-10T04:00:00.000Z' }),
      msg('rA2', { tmid: 'parentA', ts: '2026-06-10T05:00:00.000Z' }),
      msg('rB1', { tmid: 'parentB', ts: '2026-06-10T09:00:00.000Z' }),
    ]);

    expect(db.countThreadReplies('parentA')).toBe(2);
    expect(db.countThreadReplies('parentB')).toBe(1);

    const parents = db.getThreadParents('r1', { limit: 10 });
    // tlm DESC: parentB (09:00) before parentA (05:00); 'plain' excluded.
    expect(parents.map((m) => m.id)).toEqual(['parentB', 'parentA']);

    // textLike filter.
    const filtered = db.getThreadParents('r1', { limit: 10, textLike: 'hello' });
    expect(filtered.map((m) => m.id)).toEqual(['parentB', 'parentA']);
  });

  it('getThreadMessages returns replies oldest-first, excluding deleted', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('r2', { tmid: 'p1', ts: '2026-06-10T02:00:00.000Z' }),
      msg('r1', { tmid: 'p1', ts: '2026-06-10T01:00:00.000Z' }),
      msg('r3', { tmid: 'p1', ts: '2026-06-10T03:00:00.000Z' }),
    ]);
    db.markMessagesDeleted(['r3']);

    expect(db.getThreadMessages('p1').map((m) => m.id)).toEqual(['r1', 'r2']);
  });

  it('findMentions matches ANY of the usernames via json_each, newest first', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('me1', { ts: '2026-06-10T01:00:00.000Z', mentions: '["jean"]' }),
      msg('other', { ts: '2026-06-10T02:00:00.000Z', mentions: '["bob"]' }),
      msg('me2', { ts: '2026-06-10T03:00:00.000Z', mentions: '["bob","jean"]' }),
      msg('all1', { ts: '2026-06-10T04:00:00.000Z', mentions: '["all"]' }),
      msg('none', { ts: '2026-06-10T05:00:00.000Z', mentions: '[]' }),
    ]);

    // Just my username: newest first, only rows that contain it.
    const mine = db.findMentions(['jean']);
    expect(mine.map((m) => m.id)).toEqual(['me2', 'me1']);

    // Channel-wide adds @all.
    const wide = db.findMentions(['jean', 'all', 'here']);
    expect(wide.map((m) => m.id)).toEqual(['all1', 'me2', 'me1']);

    // Empty username list short-circuits to no rows.
    expect(db.findMentions([])).toEqual([]);
  });

  it('findMentions honors sinceTs, limit, and excludes soft-deleted', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([
      msg('old', { ts: '2026-06-01T00:00:00.000Z', mentions: '["jean"]' }),
      msg('mid', { ts: '2026-06-08T00:00:00.000Z', mentions: '["jean"]' }),
      msg('new', { ts: '2026-06-10T00:00:00.000Z', mentions: '["jean"]' }),
      msg('del', { ts: '2026-06-10T01:00:00.000Z', mentions: '["jean"]' }),
    ]);
    db.markMessagesDeleted(['del']);

    // sinceTs excludes 'old'; deleted 'del' never appears.
    const recent = db.findMentions(['jean'], { sinceTs: '2026-06-05T00:00:00.000Z' });
    expect(recent.map((m) => m.id)).toEqual(['new', 'mid']);

    // limit caps to the newest N.
    const capped = db.findMentions(['jean'], { limit: 1 });
    expect(capped.map((m) => m.id)).toEqual(['new']);
  });

  it('findMentions reflects edits that change the mentions list', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.upsertMessages([msg('m1', { mentions: '["bob"]' })]);
    expect(db.findMentions(['jean'])).toEqual([]);

    // Edit re-targets the mention at me.
    db.upsertMessages([msg('m1', { mentions: '["jean"]' })]);
    expect(db.findMentions(['jean']).map((m) => m.id)).toEqual(['m1']);

    // Another edit drops me again.
    db.upsertMessages([msg('m1', { mentions: '["carol"]' })]);
    expect(db.findMentions(['jean'])).toEqual([]);
  });

  it('thread_sync get/set round-trips', () => {
    db = openDb(':memory:');
    expect(db.getThreadSync('t1')).toBeUndefined();
    db.setThreadSync('t1', { lastSyncedAt: '2026-06-10T00:00:00.000Z', fullyLoaded: true });
    const row = db.getThreadSync('t1');
    expect(row?.last_synced_at).toBe('2026-06-10T00:00:00.000Z');
    expect(row?.fully_loaded).toBe(1);
  });

  it('setRoomSyncState updates only provided fields', () => {
    db = openDb(':memory:');
    db.upsertRoom(room('r1'));
    db.setRoomSyncState('r1', { oldestLoadedTs: '2026-06-01T00:00:00.000Z', fullyBackfilled: true });
    const r = db.getRoom('r1');
    expect(r?.oldest_loaded_ts).toBe('2026-06-01T00:00:00.000Z');
    expect(r?.fully_backfilled).toBe(1);
    expect(r?.last_synced_at).toBeNull();
  });

  it('upsertRoom does not clobber sync watermarks on re-upsert', () => {
    db = openDb(':memory:');
    // Insert initial room (no watermarks).
    db.upsertRoom(room('r1', { name: 'old-name', unread: 0 }));
    // Set watermarks via setRoomSyncState.
    db.setRoomSyncState('r1', {
      lastSyncedAt: '2026-06-10T10:00:00.000Z',
      oldestLoadedTs: '2026-06-01T00:00:00.000Z',
      fullyBackfilled: true,
    });
    // Re-upsert with fresh subscription data (no watermarks in row).
    db.upsertRoom(room('r1', { name: 'new-name', unread: 5 }));
    const r = db.getRoom('r1');
    // Directory fields updated.
    expect(r?.name).toBe('new-name');
    expect(r?.unread).toBe(5);
    // Watermarks survive.
    expect(r?.last_synced_at).toBe('2026-06-10T10:00:00.000Z');
    expect(r?.oldest_loaded_ts).toBe('2026-06-01T00:00:00.000Z');
    expect(r?.fully_backfilled).toBe(1);
  });

  it('ls/tunread update on subscription re-upsert but sync watermarks survive', () => {
    db = openDb(':memory:');
    // Initial subscription state: read marker + one unread thread + alert set.
    db.upsertRoom(
      room('r1', {
        unread: 2,
        ls: '2026-06-10T08:00:00.000Z',
        tunread: '["p1"]',
        alert: 1,
      }),
    );
    // Sync engine sets watermarks independently.
    db.setRoomSyncState('r1', {
      lastSyncedAt: '2026-06-10T10:00:00.000Z',
      oldestLoadedTs: '2026-06-01T00:00:00.000Z',
      fullyBackfilled: true,
    });
    // Fresh subscription data arrives (room re-upsert with NO watermarks):
    // the user read more, so ls advances and tunread clears.
    db.upsertRoom(
      room('r1', {
        unread: 0,
        ls: '2026-06-10T12:00:00.000Z',
        tunread: '[]',
        alert: 0,
      }),
    );
    const r = db.getRoom('r1');
    // Subscription-sourced fields updated on conflict.
    expect(r?.ls).toBe('2026-06-10T12:00:00.000Z');
    expect(r?.tunread).toBe('[]');
    expect(r?.unread).toBe(0);
    // `alert` is subscription-sourced too: it clears on conflict when read.
    expect(r?.alert).toBe(0);
    // Sync watermarks preserved (NOT in the ON CONFLICT SET list).
    expect(r?.last_synced_at).toBe('2026-06-10T10:00:00.000Z');
    expect(r?.oldest_loaded_ts).toBe('2026-06-01T00:00:00.000Z');
    expect(r?.fully_backfilled).toBe(1);
  });

  it('findUnreadRooms returns rooms with unread > 0 OR alert OR non-empty tunread', () => {
    db = openDb(':memory:');
    db.upsertRooms([
      room('read', { name: 'read', unread: 0, tunread: '[]', alert: 0 }),
      room('hasUnread', { name: 'hasUnread', unread: 3, tunread: '[]', alert: 0 }),
      room('hasThread', { name: 'hasThread', unread: 0, tunread: '["p1"]', alert: 0 }),
      // Plain unread message on a mentions-only server: count stays 0, no
      // thread, only the sidebar `alert` flag flips. Must still be surfaced.
      room('alertOnly', { name: 'alertOnly', unread: 0, tunread: '[]', alert: 1 }),
    ]);
    expect(db.findUnreadRooms().map((r) => r.rid).sort()).toEqual([
      'alertOnly',
      'hasThread',
      'hasUnread',
    ]);
  });

  it('findRooms filters by type and nameLike', () => {
    db = openDb(':memory:');
    db.upsertRooms([
      room('c1', { name: 'general', t: 'c' }),
      room('p1', { name: 'secret-group', t: 'p' }),
      room('d1', { name: 'alice', t: 'd' }),
    ]);
    expect(db.findRooms({ type: 'p' }).map((r) => r.rid)).toEqual(['p1']);
    expect(db.findRooms({ nameLike: 'gen' }).map((r) => r.rid)).toEqual(['c1']);
    expect(db.findRooms().length).toBe(3);
  });
});
