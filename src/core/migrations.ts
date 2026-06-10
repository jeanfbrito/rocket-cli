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
];

/** Highest schema version defined by the migration set. */
export const LATEST_SCHEMA_VERSION =
  MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1]!.version : 0;
