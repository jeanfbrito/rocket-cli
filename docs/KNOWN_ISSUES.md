# Known Issues

## External VACUUM corrupts the FTS index

- **Status**: by design (SQLite limitation), low risk in normal use
- **What**: `messages_fts` is an FTS5 external-content table keyed by `messages.rowid`. `VACUUM` can renumber rowids, silently desyncing the search index. The tool itself never runs VACUUM (WAL mode, auto-vacuum off), so this only happens if you run `sqlite3 cache.db 'VACUUM'` manually.
- **Workaround**: after any manual VACUUM, rebuild the index:
  ```sql
  INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
  ```
  A future `rocket-cli db vacuum` command should pair VACUUM with this rebuild automatically.
- **Affected files**: `src/core/migrations.ts` (FTS DDL), `src/core/search.ts`

## npm install requires typia override

- **Status**: permanent until fixed upstream
- **What**: `@rocket.chat/core-typings` (transitive dep of `@rocket.chat/api-client`) publishes a Yarn-only `patch:typia@npm%3A9.7.2#~/.yarn/patches/…` dependency URL into public npm metadata. npm refuses to resolve the `patch:` protocol and install fails.
- **Workaround**: `package.json` carries `"overrides": { "typia": "9.7.2" }`, remapping to the plain registry version. Do not remove it.
- **Reference**: Rocket.Chat monorepo publishing pipeline issue (yarn patch protocol leaking into published package.json)
- **Affected files**: `package.json`
