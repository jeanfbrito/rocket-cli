// Single source of truth for SQLite row shapes shared across the core layer.
// NOTE for db.ts builder: db.ts should import MessageRow / RoomRow from here
// instead of re-declaring them, so the schema and the normalizer agree.

/**
 * A row in the `messages` table. Mirrors the v1 SQLite schema.
 * `text` and `deleted` are NOT NULL with defaults at the DB level.
 */
export interface MessageRow {
  id: string;
  rid: string;
  author_id: string | null;
  author_username: string | null;
  author_name: string | null;
  text: string;
  ts: string; // ISO8601, lexicographically sortable
  tmid: string | null;
  tcount: number | null;
  tlm: string | null; // ISO8601
  edited_at: string | null; // ISO8601
  system_type: string | null; // RC system message type ('uj','ul','ru',...)
  attachments_json: string | null; // JSON array of one-liner strings
  deleted: number; // 0 | 1
  updated_at: string | null; // ISO8601, from _updatedAt
  /** JSON array of mentioned usernames (incl. 'all'/'here'), from
   *  IMessage.mentions. Defaults to '[]'. Optional on the type because rows
   *  cached before schema v5 may predate the column population. */
  mentions?: string;
}

/**
 * A row in the `rooms` table (subset populated from a subscription).
 * Sync watermarks (last_synced_at, oldest_loaded_ts, fully_backfilled) are
 * managed by the sync engine, not the normalizer.
 */
export interface RoomRow {
  rid: string;
  name: string | null;
  fname: string | null;
  t: string; // 'c' | 'p' | 'd'
  unread: number;
  /** syncMessages lastUpdate watermark (ISO8601) or null. Managed by sync engine. */
  last_synced_at?: string | null;
  /** Backfill horizon (ISO8601) or null. Managed by sync engine. */
  oldest_loaded_ts?: string | null;
  /** 0 | 1. Managed by sync engine. */
  fully_backfilled?: number;
  sub_updated_at: string | null; // ISO8601, from subscription _updatedAt
  /** Last-read watermark (ISO8601) from ISubscription.ls, or null if the room
   *  has never been opened. Messages with ts > ls are unread. From subscription. */
  ls?: string | null;
  /** JSON array of thread-parent ids with unread replies, from
   *  ISubscription.tunread. Defaults to '[]'. From subscription. */
  tunread?: string;
}

/**
 * A row in the `custom_emojis` table. Mirrors the v3 SQLite schema.
 * `aliases` is the JSON-stringified `string[]` from IEmojiCustom.aliases;
 * `name` is NOT NULL + UNIQUE. The directory layer parses `aliases` back into
 * an array when surfacing emojis to callers.
 */
export interface EmojiRow {
  id: string;
  name: string;
  aliases: string; // JSON array of alias strings, e.g. '["smile"]'
  extension: string | null;
  updated_at: string | null; // ISO8601, from _updatedAt
  /** Cached asset bytes, or null when not yet fetched. better-sqlite3 returns
   *  a Buffer for BLOB columns. */
  image?: Buffer | null;
  content_type?: string | null; // MIME type of the cached image, or null
}

/**
 * Compact, LLM-facing message record. Empty / null fields are omitted.
 */
export interface CompactMessage {
  id: string;
  author: string;
  text: string;
  time: string;
  threadId?: string;
  replyCount?: number;
  lastReplyAt?: string;
  edited?: true;
  system?: string;
  attachments?: string[];
  /** Absolute deep-link to this message in the Rocket.Chat web UI, when the
   *  emitting surface knows the room + base URL. Lets summaries cite sources. */
  link?: string;
}
