import BetterSqlite3 from 'better-sqlite3';
import type { Database, Statement } from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';
import type { EmojiRow, MessageRow, RoomRow } from './types.js';

export type { EmojiRow, MessageRow, RoomRow } from './types.js';

/** A row in the `thread_sync` table. */
export interface ThreadSyncRow {
  tmid: string;
  last_synced_at: string | null;
  fully_loaded: number;
}

export interface RoomFilter {
  nameLike?: string;
  type?: string;
}

export interface RoomSyncState {
  lastSyncedAt?: string | null;
  oldestLoadedTs?: string | null;
  fullyBackfilled?: boolean;
}

export interface TimelineOptions {
  limit: number;
  beforeTs?: string;
  afterTs?: string;
  includeSystem?: boolean;
}

export interface ThreadMessagesOptions {
  limit?: number;
  beforeTs?: string;
}

export interface ThreadParentsOptions {
  limit: number;
  textLike?: string;
}

export interface ThreadSyncState {
  lastSyncedAt?: string | null;
  fullyLoaded?: boolean;
}

const MUTABLE_MESSAGE_COLUMNS = [
  'rid',
  'author_id',
  'author_username',
  'author_name',
  'text',
  'ts',
  'tmid',
  'tcount',
  'tlm',
  'edited_at',
  'system_type',
  'attachments_json',
  'deleted',
  'updated_at',
] as const;

/**
 * Wraps a single better-sqlite3 connection plus its prepared statements.
 * One instance per process; DI-friendly so sync.ts / search.ts can receive it.
 */
export class Db {
  readonly conn: Database;

  // Prepared statements (compiled once at construction).
  private readonly stmtGetMeta: Statement;
  private readonly stmtSetMeta: Statement;
  private readonly stmtUpsertRoom: Statement;
  private readonly stmtGetRoom: Statement;
  private readonly stmtUpsertMessage: Statement;
  private readonly stmtMarkDeleted: Statement;
  private readonly stmtGetMessage: Statement;
  private readonly stmtCountThreadReplies: Statement;
  private readonly stmtGetThreadSync: Statement;
  private readonly stmtUpsertEmoji: Statement;
  private readonly stmtRemoveEmoji: Statement;
  private readonly stmtSetEmojiImage: Statement;
  private readonly stmtGetEmojiImage: Statement;

  private readonly txUpsertRooms: (rooms: RoomRow[]) => void;
  private readonly txUpsertMessages: (rows: MessageRow[]) => void;
  private readonly txMarkDeleted: (ids: string[]) => void;
  private readonly txUpsertEmojis: (rows: EmojiRow[]) => void;
  private readonly txRemoveEmojis: (ids: string[]) => void;

  constructor(conn: Database) {
    this.conn = conn;

    this.stmtGetMeta = conn.prepare('SELECT value FROM meta WHERE key = ?');
    this.stmtSetMeta = conn.prepare(
      `INSERT INTO meta (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );

    this.stmtUpsertRoom = conn.prepare(
      `INSERT INTO rooms (
         rid, name, fname, t, unread, last_synced_at,
         oldest_loaded_ts, fully_backfilled, sub_updated_at
       ) VALUES (
         @rid, @name, @fname, @t, @unread, @last_synced_at,
         @oldest_loaded_ts, @fully_backfilled, @sub_updated_at
       )
       ON CONFLICT(rid) DO UPDATE SET
         name = excluded.name,
         fname = excluded.fname,
         t = excluded.t,
         unread = excluded.unread,
         sub_updated_at = excluded.sub_updated_at`,
    );
    this.stmtGetRoom = conn.prepare('SELECT * FROM rooms WHERE rid = ?');

    const updateClause = MUTABLE_MESSAGE_COLUMNS.map(
      (c) => `${c} = excluded.${c}`,
    ).join(', ');
    this.stmtUpsertMessage = conn.prepare(
      `INSERT INTO messages (
         id, rid, author_id, author_username, author_name, text, ts,
         tmid, tcount, tlm, edited_at, system_type, attachments_json,
         deleted, updated_at
       ) VALUES (
         @id, @rid, @author_id, @author_username, @author_name, @text, @ts,
         @tmid, @tcount, @tlm, @edited_at, @system_type, @attachments_json,
         @deleted, @updated_at
       )
       ON CONFLICT(id) DO UPDATE SET ${updateClause}`,
    );

    this.stmtMarkDeleted = conn.prepare(
      'UPDATE messages SET deleted = 1 WHERE id = ?',
    );
    this.stmtGetMessage = conn.prepare('SELECT * FROM messages WHERE id = ?');
    this.stmtCountThreadReplies = conn.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE tmid = ? AND deleted = 0',
    );

    this.stmtGetThreadSync = conn.prepare(
      'SELECT * FROM thread_sync WHERE tmid = ?',
    );

    // Keyed on the PK (id): the common server mutation is a rename (same _id,
    // new name/aliases), which this upsert applies in place. The `name` UNIQUE
    // constraint still guards against two distinct emojis claiming one name.
    // Metadata-only: it never touches image/content_type, so a no-op delta
    // re-upsert leaves a previously-cached image intact. The image is written
    // separately via setEmojiImage after the asset fetch succeeds.
    this.stmtUpsertEmoji = conn.prepare(
      `INSERT INTO custom_emojis (id, name, aliases, extension, updated_at)
       VALUES (@id, @name, @aliases, @extension, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         aliases = excluded.aliases,
         extension = excluded.extension,
         updated_at = excluded.updated_at`,
    );
    this.stmtRemoveEmoji = conn.prepare('DELETE FROM custom_emojis WHERE id = ?');
    this.stmtSetEmojiImage = conn.prepare(
      'UPDATE custom_emojis SET image = @image, content_type = @content_type WHERE id = @id',
    );
    this.stmtGetEmojiImage = conn.prepare(
      'SELECT image, content_type FROM custom_emojis WHERE id = ?',
    );

    this.txUpsertRooms = conn.transaction((rooms: RoomRow[]) => {
      for (const room of rooms)
        this.stmtUpsertRoom.run({
          ...room,
          last_synced_at: room.last_synced_at ?? null,
          oldest_loaded_ts: room.oldest_loaded_ts ?? null,
          fully_backfilled: room.fully_backfilled ?? 0,
        });
    });
    this.txUpsertMessages = conn.transaction((rows: MessageRow[]) => {
      for (const row of rows) this.stmtUpsertMessage.run(row);
    });
    this.txMarkDeleted = conn.transaction((ids: string[]) => {
      for (const id of ids) this.stmtMarkDeleted.run(id);
    });
    this.txUpsertEmojis = conn.transaction((rows: EmojiRow[]) => {
      for (const row of rows)
        // Bind ONLY the metadata columns — passing image/content_type would be
        // an unused named param (better-sqlite3 rejects extras).
        this.stmtUpsertEmoji.run({
          id: row.id,
          name: row.name,
          aliases: row.aliases,
          extension: row.extension ?? null,
          updated_at: row.updated_at ?? null,
        });
    });
    this.txRemoveEmojis = conn.transaction((ids: string[]) => {
      for (const id of ids) this.stmtRemoveEmoji.run(id);
    });
  }

  // ---- meta ---------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run({ key, value });
  }

  // ---- rooms --------------------------------------------------------------

  upsertRoom(room: RoomRow): void {
    this.stmtUpsertRoom.run({
      ...room,
      last_synced_at: room.last_synced_at ?? null,
      oldest_loaded_ts: room.oldest_loaded_ts ?? null,
      fully_backfilled: room.fully_backfilled ?? 0,
    });
  }

  upsertRooms(rooms: RoomRow[]): void {
    this.txUpsertRooms(rooms);
  }

  getRoom(rid: string): RoomRow | undefined {
    return this.stmtGetRoom.get(rid) as RoomRow | undefined;
  }

  findRooms(filter?: RoomFilter): RoomRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.type !== undefined) {
      clauses.push('t = @type');
      params['type'] = filter.type;
    }
    if (filter?.nameLike !== undefined) {
      clauses.push('(name LIKE @nameLike OR fname LIKE @nameLike)');
      params['nameLike'] = `%${filter.nameLike}%`;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.conn
      .prepare(`SELECT * FROM rooms ${where} ORDER BY name`)
      .all(params) as RoomRow[];
  }

  setRoomSyncState(rid: string, state: RoomSyncState): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { rid };
    if (state.lastSyncedAt !== undefined) {
      sets.push('last_synced_at = @lastSyncedAt');
      params['lastSyncedAt'] = state.lastSyncedAt;
    }
    if (state.oldestLoadedTs !== undefined) {
      sets.push('oldest_loaded_ts = @oldestLoadedTs');
      params['oldestLoadedTs'] = state.oldestLoadedTs;
    }
    if (state.fullyBackfilled !== undefined) {
      sets.push('fully_backfilled = @fullyBackfilled');
      params['fullyBackfilled'] = state.fullyBackfilled ? 1 : 0;
    }
    if (sets.length === 0) return;
    this.conn
      .prepare(`UPDATE rooms SET ${sets.join(', ')} WHERE rid = @rid`)
      .run(params);
  }

  // ---- messages -----------------------------------------------------------

  upsertMessages(rows: MessageRow[]): void {
    this.txUpsertMessages(rows);
  }

  markMessagesDeleted(ids: string[]): void {
    this.txMarkDeleted(ids);
  }

  getMessage(id: string): MessageRow | undefined {
    return this.stmtGetMessage.get(id) as MessageRow | undefined;
  }

  /**
   * Main room timeline: non-deleted top-level messages (tmid IS NULL),
   * newest first. `includeSystem=false` (default) excludes system messages
   * (system_type NOT NULL).
   */
  getTimeline(rid: string, opts: TimelineOptions): MessageRow[] {
    const clauses = ['rid = @rid', 'deleted = 0', 'tmid IS NULL'];
    const params: Record<string, unknown> = { rid, limit: opts.limit };
    if (opts.includeSystem !== true) {
      clauses.push('system_type IS NULL');
    }
    if (opts.beforeTs !== undefined) {
      clauses.push('ts < @beforeTs');
      params['beforeTs'] = opts.beforeTs;
    }
    if (opts.afterTs !== undefined) {
      clauses.push('ts > @afterTs');
      params['afterTs'] = opts.afterTs;
    }
    return this.conn
      .prepare(
        `SELECT * FROM messages WHERE ${clauses.join(
          ' AND ',
        )} ORDER BY ts DESC LIMIT @limit`,
      )
      .all(params) as MessageRow[];
  }

  /** Replies belonging to a thread, oldest first. */
  getThreadMessages(tmid: string, opts: ThreadMessagesOptions = {}): MessageRow[] {
    const clauses = ['tmid = @tmid', 'deleted = 0'];
    const params: Record<string, unknown> = { tmid };
    if (opts.beforeTs !== undefined) {
      clauses.push('ts < @beforeTs');
      params['beforeTs'] = opts.beforeTs;
    }
    let sql = `SELECT * FROM messages WHERE ${clauses.join(
      ' AND ',
    )} ORDER BY ts ASC`;
    if (opts.limit !== undefined) {
      sql += ' LIMIT @limit';
      params['limit'] = opts.limit;
    }
    return this.conn.prepare(sql).all(params) as MessageRow[];
  }

  countThreadReplies(tmid: string): number {
    const row = this.stmtCountThreadReplies.get(tmid) as { n: number };
    return row.n;
  }

  /** Thread parents in a room (tcount > 0), most recently active first. */
  getThreadParents(rid: string, opts: ThreadParentsOptions): MessageRow[] {
    const clauses = ['rid = @rid', 'deleted = 0', 'tcount > 0'];
    const params: Record<string, unknown> = { rid, limit: opts.limit };
    if (opts.textLike !== undefined) {
      clauses.push('text LIKE @textLike');
      params['textLike'] = `%${opts.textLike}%`;
    }
    return this.conn
      .prepare(
        `SELECT * FROM messages WHERE ${clauses.join(
          ' AND ',
        )} ORDER BY tlm DESC LIMIT @limit`,
      )
      .all(params) as MessageRow[];
  }

  // ---- thread_sync --------------------------------------------------------

  getThreadSync(tmid: string): ThreadSyncRow | undefined {
    return this.stmtGetThreadSync.get(tmid) as ThreadSyncRow | undefined;
  }

  setThreadSync(tmid: string, state: ThreadSyncState): void {
    const lastSyncedAt =
      state.lastSyncedAt !== undefined ? state.lastSyncedAt : null;
    const fullyLoaded = state.fullyLoaded ? 1 : 0;
    this.conn
      .prepare(
        `INSERT INTO thread_sync (tmid, last_synced_at, fully_loaded)
         VALUES (@tmid, @lastSyncedAt, @fullyLoaded)
         ON CONFLICT(tmid) DO UPDATE SET
           last_synced_at = excluded.last_synced_at,
           fully_loaded = excluded.fully_loaded`,
      )
      .run({ tmid, lastSyncedAt, fullyLoaded });
  }

  // ---- custom emojis ------------------------------------------------------

  upsertEmojis(rows: EmojiRow[]): void {
    this.txUpsertEmojis(rows);
  }

  removeEmojis(ids: string[]): void {
    this.txRemoveEmojis(ids);
  }

  /**
   * All custom emojis, ordered by name. With `nameLike`, restricts to rows
   * whose name contains the substring (case-insensitive via LIKE). Alias-aware
   * matching is intentionally NOT done here — the db layer stays dumb and the
   * EmojiDirectory parses `aliases` JSON to filter/suggest in JS.
   *
   * Selects metadata columns only (no `image` BLOB) — list/suggest never need
   * the bytes, so we avoid dragging blobs through every read. Use
   * getEmojiImage() for the asset.
   */
  findEmojis(nameLike?: string): EmojiRow[] {
    const cols = 'id, name, aliases, extension, updated_at';
    if (nameLike === undefined) {
      return this.conn
        .prepare(`SELECT ${cols} FROM custom_emojis ORDER BY name`)
        .all() as EmojiRow[];
    }
    return this.conn
      .prepare(`SELECT ${cols} FROM custom_emojis WHERE name LIKE @nameLike ORDER BY name`)
      .all({ nameLike: `%${nameLike}%` }) as EmojiRow[];
  }

  /** True if a custom emoji with this exact name exists (case-insensitive). */
  emojiExists(name: string): boolean {
    const row = this.conn
      .prepare('SELECT 1 FROM custom_emojis WHERE name = ? COLLATE NOCASE LIMIT 1')
      .get(name);
    return row !== undefined;
  }

  /** Store (or replace) the cached image bytes + MIME for an emoji by id. */
  setEmojiImage(id: string, image: Buffer, contentType: string): void {
    this.stmtSetEmojiImage.run({ id, image, content_type: contentType });
  }

  /**
   * Cached image bytes + content type for an emoji by id, or undefined if the
   * row is missing or its image has not been fetched yet.
   */
  getEmojiImage(id: string): { image: Buffer; contentType: string } | undefined {
    const row = this.stmtGetEmojiImage.get(id) as
      | { image: Buffer | null; content_type: string | null }
      | undefined;
    if (!row || row.image == null || row.content_type == null) return undefined;
    return { image: row.image, contentType: row.content_type };
  }

  // ---- lifecycle ----------------------------------------------------------

  close(): void {
    this.conn.close();
  }
}

/**
 * Apply any migrations whose version is greater than the stored schema_version,
 * in a single transaction. The meta table is created by the v1 migration, so
 * before that exists `schema_version` is treated as 0.
 */
function runMigrations(conn: Database): void {
  const hasMeta = conn
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    )
    .get();
  let current = 0;
  if (hasMeta) {
    const row = conn
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (row) current = Number(row.value);
  }

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return;

  const apply = conn.transaction(() => {
    for (const migration of pending) {
      for (const stmt of migration.statements) {
        conn.exec(stmt);
      }
    }
    conn
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', @v)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run({ v: String(LATEST_SCHEMA_VERSION) });
  });
  apply();
}

/**
 * Open (or create) the SQLite database at `path`, apply pragmas and migrations,
 * and return a wrapped Db. Pass ':memory:' for an ephemeral test database.
 */
export function openDb(path: string): Db {
  const conn = new BetterSqlite3(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('foreign_keys = ON');
  runMigrations(conn);
  return new Db(conn);
}
