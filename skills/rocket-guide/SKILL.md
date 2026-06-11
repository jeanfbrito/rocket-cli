---
name: rocket-guide
description: Reference for the rocket-cli tools, cache model, and CLI↔MCP mapping. Use when the user asks "what rocket-cli tools are there", "how do I use the rocket MCP", "what can rocket-cli do", "which tool does X", "how does the rocket cache work", or "how do profiles work". Also consult this when you need to pick the right tool for a Rocket.Chat task and the dedicated rocket-* skills don't already cover it.
---

# rocket-guide

Map of the rocket-cli surface: 18 MCP tools, the cache model, profiles, and the CLI↔MCP correspondence.

## Transport

- When the rocket-cli MCP server is connected, prefer its tools (registered under the server you configured — referenced here by their bare snake_case names).
- Otherwise every read tool has a CLI equivalent: `rocket-cli <cmd> --json`.
- Multi-server: `--profile <name>` (CLI) or `ROCKET_CLI_PROFILE` (MCP env). Each profile is an isolated server identity with its own cache db.

## All MCP tools

| Tool | Purpose | Key params |
|---|---|---|
| `list_rooms` | List rooms you belong to (channels, groups, DMs); discover ids/names | `filter?`, `type?` (channel/group/dm), `limit` (≤200, def 50) |
| `get_messages` | Read recent messages in a room, newest-first; thread parents carry `replyCount` | `room`, `count` (≤100, def 30), `before?`/`after?` ISO, `includeSystem` (def false) |
| `get_unread` | Unread messages since each room's last-read watermark (UI-parity) | `limitPerRoom` (≤100, def 50), `includeThreads` (def true), `includeHidden` (def false) |
| `get_mentions` | Messages that @-mention the user across cached rooms | `sinceDays` (1-90, def 7), `limit` (≤100, def 50), `includeChannelWide` (def false) |
| `get_attention` | One-call triage: mentions + unread DMs + unread threads + unread channels, prioritized | `sinceDays` (1-90, def 7), `limitPerSection` (≤100, def 30), `includeChannelWide` (def false) |
| `get_message_context` | Conversation around a message id/link; thread replies pivot to the whole thread | `messageId`, `before` (0-50, def 10), `after` (0-50, def 5) |
| `open_url` | Resolve any pasted Rocket.Chat link → content + action ids | `url`, `count` (≤100, def 20) |
| `get_thread_messages` | Full thread: parent + replies, chronological | `threadId` (id or link), `count` (≤200, def 50) |
| `list_threads` | Active threads in a room, most-recent first | `room`, `count` (≤100, def 25), `text?` |
| `sync_history` | Load older history for ONE room into the cache (explicit depth only) | `room?` (omit = most stale unread room), `depth?` (≤5000) |
| `search_messages` | Full-text search; cross-room = local cache only; `room` enables server fallback | `query`, `room?`, `author?`, `limit` (≤100, def 20) |
| `send_message` | Send to a room or reply in a thread (write) | `target`, `text`, `threadId?` |
| `add_reaction` | React to a message / remove a reaction (write) | `messageId` (id or link), `emoji`, `remove` (def false) |
| `upload_file` | Attach a local file to a room/thread (write) | `room`, `filePath`, `text?`, `threadId?`, `fileName?` |
| `get_user_profile` | Look up a user by username/id (status, existence) | `user` |
| `download_attachment` | Download a message attachment to local disk | `fileUrl` (the part after `->`), `savePath?` |
| `list_custom_emojis` | List server custom emojis (names for `:name:` / `add_reaction`) | `filter?` |
| `get_custom_emoji` | Show a custom emoji's image | `name` |

The three write tools (`send_message`, `add_reaction`, `upload_file`) are omitted on a read-only profile → 15 tools instead of 18. `download_attachment` and `sync_history` stay (they touch only local disk / the local cache, never the server).

## Cache model (5 lines)

1. **Lazy backfill** — first read of a room fetches ≤500 messages / 30 days (paged by 100).
2. **Delta sync** — later reads call `chat.syncMessages` (60 s TTL), applying edits/deletes locally.
3. **Storage** — SQLite + FTS5 full-text index; each profile has an isolated db; zero network on cache-fresh rooms.
4. **SWR reads** — `get_messages` / `list_threads` serve cache instantly and revalidate in the background (`refreshing: true` = data may be seconds stale). Triage tools (`get_unread`/`get_mentions`/`get_attention`) fetch only the unread slice.
5. **Intent-driven depth** — no ambient warmer; deep history only via `sync_history` (one room) or `rocket-cli sync --all`. Envelopes expose `syncedThrough` + `coverage` as honesty markers — never claim completeness beyond them.

## Profile selection

`--profile <name>` flag or `ROCKET_CLI_PROFILE` env selects a named profile; its connection identity (`url`, `token`, `userId`, `db`) is authoritative. A `defaultProfile` applies when nothing is selected and no `ROCKETCHAT_URL` is in the environment. Tokens are never printed. Manage with `rocket-cli profiles`.

## CLI ↔ MCP mapping

| CLI | MCP tool |
|---|---|
| `rocket-cli rooms` | `list_rooms` |
| `rocket-cli messages <room>` | `get_messages` |
| `rocket-cli unread` | `get_unread` |
| `rocket-cli mentions` | `get_mentions` |
| `rocket-cli attention` | `get_attention` |
| `rocket-cli context <messageId>` | `get_message_context` |
| `rocket-cli open <url>` | `open_url` |
| `rocket-cli threads <room>` | `list_threads` |
| `rocket-cli thread <id>` | `get_thread_messages` |
| `rocket-cli sync [room]` | `sync_history` |
| `rocket-cli search <query>` | `search_messages` |
| `rocket-cli send <target> [text…]` | `send_message` |
| `rocket-cli upload <room> <file>` | `upload_file` |
| `rocket-cli download <fileUrl>` | `download_attachment` |
| `rocket-cli emojis` | `list_custom_emojis` / `get_custom_emoji` |
| `rocket-cli watch <query>` | (CLI-only: live local FTS watch) |
| `rocket-cli serve` | (starts the MCP stdio server itself) |
| `rocket-cli profiles` | (CLI-only: manage connection profiles) |

All read CLIs accept `--json` for machine-readable output. For task workflows, defer to the dedicated skills: rocket-attention (triage), rocket-catchup (room/thread recap), rocket-find (search), rocket-link (pasted URLs), rocket-send (writes).
