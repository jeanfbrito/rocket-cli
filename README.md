# rocket-cli

Rocket.Chat bridge with a local SQLite/FTS5 cache — CLI for humans, MCP server for LLM agents.

On first read a room is backfilled (up to 500 messages / 30 days). Subsequent reads hit `chat.syncMessages` for deltas (60 s TTL), then serve from SQLite — zero network on cache-fresh rooms. Full-text search runs across all cached rooms locally via FTS5; when scoped to a room it falls back to the server and ingests the results into the cache.

## Setup

**Requirements**: Node >= 20, `npm`

```sh
npm install
npm run build
cp .env.example .env
```

Edit `.env` with your Rocket.Chat URL and credentials. See [Environment variables](#environment-variables) below.

**Create a Personal Access Token** in Rocket.Chat: My Account → Personal Access Tokens → Add. Enable **Ignore Two Factor Authentication** to avoid 2FA prompts on every API call.

## CLI usage

All commands accept `--json` for machine-readable output.

```sh
# List rooms you belong to
node dist/cli.js rooms
node dist/cli.js rooms --type channel
node dist/cli.js rooms --filter infra

# Sync a room or all rooms
node dist/cli.js sync #dev
node dist/cli.js sync --all
node dist/cli.js sync --all --force   # bypass TTL, re-fetch everything

# Read messages
node dist/cli.js messages #dev -n 50
node dist/cli.js messages #dev -n 20 --before 2026-06-01T00:00:00.000Z

# Full-text search (cross-room by default)
node dist/cli.js search "deploy error"
node dist/cli.js search "deploy error" --room #dev
node dist/cli.js search "deploy error" --room #dev --author jsmith --limit 10

# Send a message
node dist/cli.js send #dev "Hello team"
node dist/cli.js send #dev "Fixed in the next build" --thread <parent-message-id>

# Start the MCP stdio server (used by Claude Code / Claude Desktop)
node dist/cli.js serve
```

### `rooms` flags

| Flag | Description |
|---|---|
| `--type <type>` | Filter by type: `c` / `channel`, `p` / `group`, `d` / `dm` |
| `--filter <substr>` | Case-insensitive name substring filter |

### `sync` flags

| Flag | Description |
|---|---|
| `[room]` | Room name, `#channel`, or id |
| `--all` | Sync every subscribed room sequentially |
| `--force` | Bypass TTL and re-sync even if cache is fresh |

### `messages` flags

| Flag | Description |
|---|---|
| `-n, --count <n>` | Number of messages to show (default 30) |
| `--before <ISO>` | Show messages older than this ISO 8601 timestamp |
| `--include-system` | Include system messages (joins, topic changes, etc.) |

### `search` flags

| Flag | Description |
|---|---|
| `--room <r>` | Limit to one room and enable server-side fallback |
| `--author <u>` | Filter by author username |
| `--limit <n>` | Maximum results (default 20) |

### `send` flags

| Flag | Description |
|---|---|
| `--thread <id>` | Reply to the thread with this parent message id |

## MCP server for Claude Code

Add to `.mcp.json` in your project root (or `~/.claude/mcp.json` for global):

```json
{
  "mcpServers": {
    "rocketchat": {
      "command": "node",
      "args": ["/absolute/path/to/rocket-cli/dist/cli.js", "serve"],
      "env": {
        "ROCKETCHAT_URL": "${ROCKETCHAT_URL}",
        "ROCKETCHAT_TOKEN": "${ROCKETCHAT_TOKEN}",
        "ROCKETCHAT_USER_ID": "${ROCKETCHAT_USER_ID}"
      }
    }
  }
}
```

Use `${VARIABLE}` env-expansion so the token is read from your shell environment, not stored literally in the file. Never commit a `.mcp.json` with a real token.

For Claude Desktop, add an equivalent entry under `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) with the same `command`/`args`/`env` structure.

See `.mcp.json.example` at the repo root for a copy-paste starting point.

## MCP tools

Eight tools are exposed to the LLM agent:

| Tool | What it does | Key inputs |
|---|---|---|
| `list_rooms` | List subscribed channels, groups, and DMs | `filter?`, `type?` (channel/group/dm), `limit?` (default 50) |
| `get_messages` | Read messages from a room, newest first | `room`, `count?` (default 30, max 100), `before?`, `after?` (ISO 8601), `includeSystem?` |
| `get_thread_messages` | Read a full thread (parent + replies) | `threadId` (parent message id), `count?` (default 50) |
| `list_threads` | List active threads in a room by last activity | `room`, `count?` (default 25), `text?` (filter parent text) |
| `search_messages` | Full-text search across all cached rooms | `query`, `room?` (scopes + enables server fallback), `author?`, `limit?` (default 20) |
| `send_message` | Post to a room or reply in a thread | `target` (#channel/@user/name/id), `text`, `threadId?` |
| `add_reaction` | Add or remove an emoji reaction on a message | `messageId`, `emoji` (colon-wrapping optional), `remove?` (bool, default false) |
| `get_user_profile` | Look up a user's profile by username or id | `user` (username with or without leading `@`, or user id) |

`get_messages` and `list_threads` return an envelope with `room`, `syncedThrough`, and `coverage` so the agent knows the freshness and depth of the cached data. Thread parents in `get_messages` carry a `replyCount`; pass that message's `id` as `threadId` to `get_thread_messages`.

## Architecture

1. **Lazy backfill** — first access to a room fetches up to 500 messages / 30 days via `channels.history` / `groups.history` / `im.history`.
2. **Delta sync** — subsequent reads call `chat.syncMessages(lastUpdate)` (60 s TTL), applying edits and deletions into the local store.
3. **FTS5 search** — BM25-ranked full-text search across all cached rooms; if results are thin and a room is specified, falls back to `chat.search` and ingests the server results into the cache.
4. **Write-through sends** — `chat.postMessage` response is upserted into the local DB, so the sent message appears in the next `get_messages` without a sync round-trip.
5. **Threads on demand** — `ensureThreadLoaded` checks `tcount` vs local reply count and backfills gaps via `chat.getThreadMessages`.

**DB location**: `~/.local/share/rocket-cli/cache.db` (XDG data home). Override with `ROCKET_CLI_DB`.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ROCKETCHAT_URL` | yes | — | Base URL of your Rocket.Chat server (e.g. `https://chat.example.com`) |
| `ROCKETCHAT_TOKEN` | yes | — | Personal Access Token |
| `ROCKETCHAT_USER_ID` | yes | — | Your Rocket.Chat user id |
| `ROCKET_CLI_DB` | no | `~/.local/share/rocket-cli/cache.db` | Override the SQLite database path |
| `ROCKET_CLI_SYNC_TTL_SECONDS` | no | `60` | How long before a cached room is considered stale |
| `ROCKET_CLI_BACKFILL_LIMIT` | no | `500` | Max messages to fetch on initial room backfill |

## Known issues

See [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md).
