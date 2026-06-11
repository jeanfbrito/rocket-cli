/**
 * Versioned SQL migration batches. Each entry is applied in order when the
 * stored `meta.schema_version` is below its `version`. Migrations run inside a
 * single transaction in db.ts.
 *
 * v1 = full schema: meta, rooms, messages (+indexes), thread_sync, and an
 * external-content FTS5 table over messages kept in sync via triggers.
 *
 * The FTS triggers are soft-delete aware. External-content FTS5 tables store
 * NO copy of the text — they only hold an inverted index keyed by rowid. The
 * 'delete' command must therefore be fed the OLD column values so FTS5 can
 * locate and remove the right index entries. If we ever issue a 'delete' for a
 * row that was never indexed (e.g. it was already deleted=1), the external
 * content integrity is corrupted. We guard every delete-half with
 * `WHEN old.deleted = 0` and every insert-half with `WHEN new.deleted = 0`,
 * splitting the UPDATE case into two independent triggers so the two halves
 * fire only when their respective row state was/is actually indexed.
 */
export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );`,

      `CREATE TABLE rooms (
        rid TEXT PRIMARY KEY,
        name TEXT,
        fname TEXT,
        t TEXT NOT NULL,
        unread INTEGER DEFAULT 0,
        last_synced_at TEXT,
        oldest_loaded_ts TEXT,
        fully_backfilled INTEGER DEFAULT 0,
        sub_updated_at TEXT
      );`,

      `CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        rid TEXT NOT NULL REFERENCES rooms(rid),
        author_id TEXT,
        author_username TEXT,
        author_name TEXT,
        text TEXT NOT NULL DEFAULT '',
        ts TEXT NOT NULL,
        tmid TEXT,
        tcount INTEGER,
        tlm TEXT,
        edited_at TEXT,
        system_type TEXT,
        attachments_json TEXT,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );`,

      `CREATE INDEX idx_messages_rid_ts ON messages (rid, ts DESC);`,

      `CREATE INDEX idx_messages_thread ON messages (tmid, ts ASC) WHERE tmid IS NOT NULL;`,

      `CREATE TABLE thread_sync (
        tmid TEXT PRIMARY KEY,
        last_synced_at TEXT,
        fully_loaded INTEGER DEFAULT 0
      );`,

      `CREATE VIRTUAL TABLE messages_fts USING fts5(
        text,
        author_username,
        content='messages',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );`,

      // INSERT: only index rows that are not soft-deleted.
      `CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.deleted = 0 BEGIN
        INSERT INTO messages_fts (rowid, text, author_username)
        VALUES (new.rowid, new.text, new.author_username);
      END;`,

      // UPDATE delete-half: evict the OLD indexed values, but only if the old
      // row was actually in the index (old.deleted = 0). Feeding 'delete' the
      // old text/author_username is mandatory for external-content FTS5.
      `CREATE TRIGGER messages_au_del AFTER UPDATE ON messages WHEN old.deleted = 0 BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, text, author_username)
        VALUES ('delete', old.rowid, old.text, old.author_username);
      END;`,

      // UPDATE insert-half: re-index the NEW values, but only if the new row
      // should be indexed (new.deleted = 0). Together with messages_au_del this
      // handles edit (0->0), soft-delete (0->1), and undelete (1->0) correctly.
      `CREATE TRIGGER messages_au_ins AFTER UPDATE ON messages WHEN new.deleted = 0 BEGIN
        INSERT INTO messages_fts (rowid, text, author_username)
        VALUES (new.rowid, new.text, new.author_username);
      END;`,

      // DELETE: evict the OLD values, only if the row was indexed.
      `CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.deleted = 0 BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, text, author_username)
        VALUES ('delete', old.rowid, old.text, old.author_username);
      END;`,
    ],
  },
  {
    // v2 — fix: the v1 UPDATE triggers fired their delete-half + insert-half on
    // EVERY update, including no-op re-upserts of identical content. Delta sync
    // (chat.syncMessages with lastUpdate) re-fetches and re-upserts already-known
    // rows on every sync, so any message synced more than once hit this path.
    //
    // For an FTS5 external-content table, issuing 'delete'(old tokens) and then
    // INSERT(identical tokens) for the same rowid in the same statement corrupts
    // the term posting list: the doc-frequency accounting nets to zero and the
    // row's terms become unsearchable, while 'integrity-check' still passes (it
    // only validates existing index entries, not missing ones). Symptom: a
    // freshly-synced message is in messages_fts by rowid but MATCH finds nothing.
    //
    // Fix: fire the delete-half / insert-half only when the indexed content
    // (text or author_username) actually changed, or the deleted flag flipped.
    // Identical re-upserts then leave the index untouched. Edit (0->0 with new
    // text), soft-delete (0->1), and undelete (1->0) all still re-index correctly.
    // We also rebuild the index once so DBs that were already desynced recover.
    version: 2,
    statements: [
      `DROP TRIGGER IF EXISTS messages_au_del;`,
      `DROP TRIGGER IF EXISTS messages_au_ins;`,

      // UPDATE delete-half: evict OLD indexed values only when the row was
      // indexed (old.deleted = 0) AND the indexed content is actually leaving
      // the index — i.e. the row is being soft-deleted, or its text/author
      // changed. `IS NOT` (not `<>`) so a NULL author is compared correctly.
      `CREATE TRIGGER messages_au_del AFTER UPDATE ON messages
       WHEN old.deleted = 0 AND (
         new.deleted = 1
         OR new.text IS NOT old.text
         OR new.author_username IS NOT old.author_username
       ) BEGIN
        INSERT INTO messages_fts (messages_fts, rowid, text, author_username)
        VALUES ('delete', old.rowid, old.text, old.author_username);
      END;`,

      // UPDATE insert-half: (re)index NEW values only when the row should be
      // indexed (new.deleted = 0) AND the indexed content is actually entering
      // or changing — i.e. the row is being undeleted, or its text/author
      // changed. Together with messages_au_del this leaves identical re-upserts
      // a no-op while still handling edit / soft-delete / undelete.
      `CREATE TRIGGER messages_au_ins AFTER UPDATE ON messages
       WHEN new.deleted = 0 AND (
         old.deleted = 1
         OR new.text IS NOT old.text
         OR new.author_username IS NOT old.author_username
       ) BEGIN
        INSERT INTO messages_fts (rowid, text, author_username)
        VALUES (new.rowid, new.text, new.author_username);
      END;`,

      // Repair any index already corrupted by the v1 triggers.
      `INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`,
    ],
  },
  {
    // v3 — custom-emoji cache for the EmojiDirectory. Mirrors the rooms table:
    // a flat local mirror of the server's custom-emoji registry, refreshed via
    // /v1/emoji-custom.list (full list, or delta when `updatedSince` is sent).
    // `aliases` is the JSON-stringified string[] from IEmojiCustom.aliases;
    // `name` is UNIQUE because the server enforces emoji-name uniqueness and we
    // resolve/suggest by name. `updated_at` holds the serialized _updatedAt so a
    // delta sync can compute a watermark and detect whether the image changed.
    //
    // `image` / `content_type` cache the actual asset bytes, fetched lazily on
    // refresh from the public `/emoji-custom/{name}.{ext}` web route (see
    // EmojiDirectory.refresh). The image is an enhancement: a NULL image is a
    // valid row whose metadata is still authoritative.
    version: 3,
    statements: [
      `CREATE TABLE custom_emojis (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        aliases TEXT NOT NULL DEFAULT '[]',
        extension TEXT,
        updated_at TEXT,
        image BLOB,
        content_type TEXT
      );`,
    ],
  },
  {
    // v4 — per-room unread state mirrored from the subscription record, so the
    // read-only `unread` command / `get_unread` tool can slice exactly the
    // messages that arrived since the user last read each room in the UI.
    //
    // `ls` is ISubscription.ls (a Date over the wire) — the "last seen" / last-read
    // watermark the server maintains when the user opens a room. We store it as an
    // ISO8601 TEXT so it compares lexicographically against messages.ts. NULL means
    // the room has no read marker yet (never opened); the unread view then falls
    // back to the unread-count newest-N approximation.
    //
    // `tunread` is ISubscription.tunread (string[] of thread parent ids with unread
    // replies). Stored as a JSON array TEXT, default '[]' so the column is never
    // NULL and JSON.parse always succeeds. (Fields verified in
    // @rocket.chat/core-typings ISubscription: `ls?: Date`, `unread: number`,
    // `tunread?: Array<string>`; subscriptions.get returns full ISubscription
    // records per @rocket.chat/rest-typings subscriptionsEndpoints.)
    version: 4,
    statements: [
      `ALTER TABLE rooms ADD COLUMN ls TEXT;`,
      `ALTER TABLE rooms ADD COLUMN tunread TEXT NOT NULL DEFAULT '[]';`,
    ],
  },
  {
    // v5 — per-message mention list, so the read-only `mentions` command /
    // `get_mentions` tool can find "what needs MY attention" across all cached
    // rooms without a full-text scan.
    //
    // `mentions` is a JSON array TEXT of the *usernames* extracted from
    // IMessage.mentions (a MessageMention[] of `{ _id, username?, name?, type? }`).
    // We keep only the usernames (entries without one are skipped) plus the
    // special channel-wide pseudo-users 'all' / 'here' (which arrive as
    // `username`). Default '[]' so the column is never NULL and JSON.parse /
    // json_each always succeed. Old rows cached before v5 stay '[]' until the
    // room is re-synced — an honest, self-healing default.
    //
    // The partial index covers only rows that actually mention someone
    // (mentions != '[]'), keyed (rid, ts DESC) to match the findMentions scan
    // (newest first, grouped by room). Cheap: the vast majority of messages
    // mention no one, so the index stays small.
    version: 5,
    statements: [
      `ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';`,
      `CREATE INDEX idx_messages_mentions ON messages (rid, ts DESC) WHERE mentions != '[]';`,
    ],
  },
  {
    // v6 — per-room `alert` flag mirrored from ISubscription.alert, so the
    // read-only `unread` command / `get_unread` tool lists exactly the rooms the
    // Rocket.Chat sidebar shows under its "Unread" section.
    //
    // WHY this is needed: the sidebar groups a room as Unread when
    // `room.alert || room.unread || room.tunread?.length` (see
    // apps/meteor/client/sidebar/hooks/useRoomList.ts). The server sets
    // `alert: true` on EVERY new message for each other member
    // (Subscriptions.setAlertForRoomIdExcludingUserId in notifyUsersOnMessage),
    // but only increments `unread` when the room's Unread_Count setting is
    // 'all_messages'. The DEFAULT Unread_Count is 'user_and_group_mentions_only',
    // so a plain (non-mention) channel/group message leaves `unread: 0` while
    // `alert: true`. Our prior predicate (unread > 0 OR tunread != '[]') missed
    // every such room — the exact gap a busy account hits. `alert` is cleared
    // (set false) when the user reads the room (Subscriptions.setAsRead...), so
    // it tracks "touched since last read" reliably.
    //
    // INTEGER 0|1 (SQLite has no boolean), NOT NULL DEFAULT 0 so existing rows
    // and re-upserts that omit it stay well-defined.
    version: 6,
    statements: [`ALTER TABLE rooms ADD COLUMN alert INTEGER NOT NULL DEFAULT 0;`],
  },
  {
    // v7 — per-room "hide unread" room setting + mention bookkeeping, so the
    // `unread` view reaches exact parity with the Rocket.Chat sidebar.
    //
    // WHY this is needed: the sidebar's Unread section hides a room whose
    // per-subscription `hideUnreadStatus` ("Hide unread counter" room setting)
    // is true (apps/meteor/client/sidebar/hooks/useRoomList.ts:
    // `(room.alert || room.unread || room.tunread?.length) && !room.hideUnreadStatus`).
    // Our prior predicate ignored that flag and over-reported every such room.
    // Worse, the server still flips `alert` on those rooms, so a busy account
    // with several "muted" rooms saw a large false unread count.
    //
    // There is ONE exception the UI keeps even for a hidden room: an explicit
    // mention. getSubscriptionUnreadData.ts computes
    // `showUnread = (!hideUnreadStatus || (!hideMentionStatus && (mentions ||
    // groupMentions))) && total > 0`, where `mentions = userMentions +
    // tunreadUser.length`. So a hidden room still surfaces when the user is
    // mentioned (`userMentions`/`groupMentions` > 0, or a thread reply mentions
    // them: `tunreadUser`) AND mentions are not also hidden (`hideMentionStatus`
    // false). All five fields are in the subscriptions.get projection
    // (apps/meteor/lib/publishFields.ts).
    //
    // Column shapes: the two hide flags are stored as INTEGER 0|1 (SQLite has no
    // boolean); the wire type is `?: true` so absence => 0. `user_mentions` /
    // `group_mentions` are server counts (required numbers on the wire).
    // `tunread_user` is a JSON array TEXT (thread parents whose unread replies
    // mention the user), mirroring the existing `tunread` column. All NOT NULL
    // with defaults so existing rows and re-upserts that omit them stay
    // well-defined; old rows self-heal on the next subscription refresh.
    version: 7,
    statements: [
      `ALTER TABLE rooms ADD COLUMN hide_unread_status INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE rooms ADD COLUMN hide_mention_status INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE rooms ADD COLUMN user_mentions INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE rooms ADD COLUMN group_mentions INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE rooms ADD COLUMN tunread_user TEXT NOT NULL DEFAULT '[]';`,
    ],
  },
  {
    // v8 — fix the idx_messages_mentions index shape so it actually backs
    // findMentions.
    //
    // WHY the v5 index was never used: the v5 index was defined as
    // (rid, ts DESC) WHERE mentions != '[]'. findMentions scans across ALL rooms
    // ordered by ts DESC globally (no rid equality predicate), so an index
    // leading on rid cannot back the ORDER BY — SQLite would still need a temp
    // B-tree. Worse, findMentions uses an EXISTS (SELECT 1 FROM json_each(...))
    // predicate, and SQLite's partial-index planner requires the query to state
    // the partial-index predicate literally in its WHERE clause; json_each over
    // '[]' yields no rows, which is semantically equivalent to mentions != '[]',
    // but the planner cannot prove it. Both problems were verified via EXPLAIN
    // QUERY PLAN: the output was SCAN messages + USE TEMP B-TREE FOR ORDER BY,
    // meaning the index was skipped entirely on every call.
    //
    // Fix: drop the old index and create a new one keyed on (ts DESC) only,
    // keeping the same partial predicate (mentions != '[]'). With this shape the
    // index is ordered the same way findMentions needs (newest first, across all
    // rooms), and findMentions now also states `mentions != '[]'` literally in
    // its WHERE clause so the planner can match the partial-index predicate.
    // EXPLAIN QUERY PLAN then shows SEARCH messages USING INDEX
    // idx_messages_mentions with no temp B-tree.
    version: 8,
    statements: [
      `DROP INDEX IF EXISTS idx_messages_mentions;`,
      `CREATE INDEX idx_messages_mentions ON messages (ts DESC) WHERE mentions != '[]';`,
    ],
  },
];

/** Highest schema version defined by the migration set. */
export const LATEST_SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1]!.version : 0;
