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
  /** Sidebar "Unread" flag (0|1) from ISubscription.alert. The server sets it
   *  true on any new message and clears it on read; the unread view treats
   *  alert=1 as unread even when the unread *count* is 0 (mentions-only servers).
   *  Defaults to 0. From subscription. */
  alert?: number;
  /** "Hide unread counter" room setting (0|1) from ISubscription.hideUnreadStatus.
   *  When set, the sidebar hides the room from the Unread section. The unread
   *  view excludes such rooms by default (UI parity), except when the user is
   *  mentioned (see hide_mention_status). Defaults to 0. From subscription. */
  hide_unread_status?: number;
  /** "Hide mention" room setting (0|1) from ISubscription.hideMentionStatus.
   *  When a room is hidden (hide_unread_status=1), an explicit mention still
   *  surfaces it UNLESS this is also set. Defaults to 0. From subscription. */
  hide_mention_status?: number;
  /** Server count of direct (@me) mentions, from ISubscription.userMentions.
   *  Drives the mention exception for hidden rooms. Defaults to 0. From subscription. */
  user_mentions?: number;
  /** Server count of group (@all/@here/role) mentions, from
   *  ISubscription.groupMentions. Defaults to 0. From subscription. */
  group_mentions?: number;
  /** JSON array of thread-parent ids whose unread replies mention the user,
   *  from ISubscription.tunreadUser. Part of the hidden-room mention exception.
   *  Defaults to '[]'. From subscription. */
  tunread_user?: string;
  /** NOT a stored column — a computed flag set only by findUnreadRooms(): 1 when
   *  the room is hidden (hide_unread_status=1) but surfaced via the mention
   *  exception. Lets reports label it distinctly. Undefined elsewhere. */
  hidden_mentioned?: number;
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
