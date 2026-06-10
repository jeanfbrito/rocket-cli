# rocket-cli

Rocket.Chat bridge with a local SQLite/FTS5 cache — CLI for humans, MCP server for LLM agents.

On first read a room is backfilled (up to 500 messages / 30 days). Subsequent reads hit `chat.syncMessages` for deltas (60 s TTL), then serve from SQLite — zero network on cache-fresh rooms. Full-text search runs across all cached rooms locally via FTS5; when scoped to a room it falls back to the server and ingests the results into the cache.

## Install

**Requirements**: Node >= 20, `npm`

```sh
git clone <repo-url>   # or your fork/path
cd rocket-cli
npm install
npm run build
npm link               # optional: puts `rocket-cli` on your PATH
```

After `npm link`, examples below can use `rocket-cli` instead of `node dist/cli.js`.

## Get your credentials

1. Open Rocket.Chat in your browser → click your avatar (top-left) → **My Account** → **Personal Access Tokens**
2. If the section is missing: an admin must enable the `API_Enable_Personal_Access_Tokens` setting, and your role needs the `create-personal-access-tokens` permission
3. Name the token (e.g. `rocket-cli`), check **Ignore Two Factor Authentication** (without it, API calls may demand TOTP codes the CLI cannot answer), then click **Add**
4. Copy both the **token** and the **user ID** — they appear together in the same confirmation dialog, and the token is shown only once
5. Copy the example env file and fill in your values:
   ```sh
   cp .env.example .env
   ```
   Set `ROCKETCHAT_URL`, `ROCKETCHAT_TOKEN`, and `ROCKETCHAT_USER_ID`. The CLI auto-loads `.env` from the directory you run it in; real environment variables always take precedence.

## Quickstart

```sh
rocket-cli rooms        # lists rooms you're subscribed to — verifies auth
rocket-cli sync --all   # initial backfill into the local cache
rocket-cli messages general -n 20
rocket-cli search "deploy"
```

Cache reset: `rm ~/.local/share/rocket-cli/cache.db*` — next run re-syncs from the server.

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

# List threads in a room; show a specific thread
node dist/cli.js threads general -n 10
node dist/cli.js thread <parent-message-id>

# Watch for messages matching a query (local FTS)
node dist/cli.js watch "deploy error" --once
node dist/cli.js watch "incident" --room #ops --interval 30

# Upload a file to a room
node dist/cli.js upload general /path/to/report.pdf --text "Q2 report"

# Download an attachment (use the link from `messages` output: [file] name -> /file-upload/…)
node dist/cli.js download /file-upload/abc123/report.pdf --out /tmp/report.pdf

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

### `threads` flags

| Flag | Description |
|---|---|
| `-n, --count <n>` | Number of threads to show (default 25) |
| `--text <filter>` | Filter threads by parent message text |

### `thread` flags

| Flag | Description |
|---|---|
| `-n, --count <n>` | Number of replies to show (default 50) |

### `watch` flags

| Flag | Description |
|---|---|
| `--room <r>` | Limit to a specific room (default: all rooms) |
| `--interval <sec>` | Poll interval in seconds (default 60) |
| `--once` | Run a single pass over the last 24 h and exit |
| `--notify <target>` | Post each match to this room or user |
| `--log <path>` | Append matches as JSON lines to a file |

### `upload` flags

| Flag | Description |
|---|---|
| `--text <t>` | Caption message for the attachment |
| `--thread <id>` | Attach inside the thread with this parent message id |
| `--name <n>` | Override the uploaded file name |

### `download` flags

| Flag | Description |
|---|---|
| `--out <path>` | Where to save the file (default: `~/Downloads/<name>`) |

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

**CLI alternative** — register with the `claude` CLI instead of editing `.mcp.json` manually:

```sh
claude mcp add rocketchat \
  -e ROCKETCHAT_URL=https://chat.example.com \
  -e ROCKETCHAT_TOKEN=your-token \
  -e ROCKETCHAT_USER_ID=your-user-id \
  -- node /absolute/path/to/rocket-cli/dist/cli.js serve
```

The `-e` flag sets env vars scoped to this MCP server; they are not exported to your shell. Run `claude mcp add --help` for scope and transport options.

## MCP tools

Ten tools are exposed to the LLM agent:

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
| `upload_file` | Attach a local file to a room or thread | `room` (#channel/@user/name/id), `filePath` (absolute path), `text?` (caption), `threadId?`, `fileName?` |
| `download_attachment` | Download a message attachment to local disk | `fileUrl` (attachment link after `->`, e.g. `/file-upload/…`), `savePath?` (default: `~/Downloads/<name>`) |

`get_messages` and `list_threads` return an envelope with `room`, `syncedThrough`, and `coverage` so the agent knows the freshness and depth of the cached data. Thread parents in `get_messages` carry a `replyCount`; pass that message's `id` as `threadId` to `get_thread_messages`.

Attachment links appear in `get_messages` output as `[file] name -> /file-upload/…`; pass the part after `->` as `fileUrl` to `download_attachment`.

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
