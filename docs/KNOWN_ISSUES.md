# Known Issues

## External VACUUM corrupts the FTS index

- **Status**: by design (SQLite limitation), low risk in normal use
- **Related (fixed)**: schema v1 had a sibling desync — identical re-upserts from delta sync fired delete+insert FTS trigger pairs that corrupted the posting list for unchanged rows. Schema v2 guards the triggers on actual content change and rebuilds the index on migration.
- **What**: `messages_fts` is an FTS5 external-content table keyed by `messages.rowid`. `VACUUM` can renumber rowids, silently desyncing the search index. The tool itself never runs VACUUM (WAL mode, auto-vacuum off), so this only happens if you run `sqlite3 cache.db 'VACUUM'` manually.
- **Workaround**: after any manual VACUUM, rebuild the index:
  ```sql
  INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
  ```
  A future `rocket-cli db vacuum` command should pair VACUUM with this rebuild automatically.
- **Affected files**: `src/core/migrations.ts` (FTS DDL), `src/core/search.ts`

## api-client upload() is browser-only

- **Status**: permanent upstream constraint
- **What**: `@rocket.chat/api-client`'s `upload()` uses `XMLHttpRequest`, which does not exist in Node. File uploads therefore bypass `RcClient` entirely: `src/core/files.ts` does raw `fetch` + `FormData` against `rooms.media`/`rooms.mediaConfirm`. Do not try to route uploads through `RcClient`.
- **Affected files**: `src/core/files.ts`

## npm install requires typia override

- **Status**: permanent until fixed upstream
- **What**: `@rocket.chat/core-typings` (transitive dep of `@rocket.chat/api-client`) publishes a Yarn-only `patch:typia@npm%3A9.7.2#~/.yarn/patches/…` dependency URL into public npm metadata. npm refuses to resolve the `patch:` protocol and install fails.
- **Workaround**: `package.json` carries `"overrides": { "typia": "9.7.2" }`, remapping to the plain registry version. Do not remove it.
- **Reference**: Rocket.Chat monorepo publishing pipeline issue (yarn patch protocol leaking into published package.json)
- **Affected files**: `package.json`
