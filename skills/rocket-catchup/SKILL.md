---
name: rocket-catchup
description: 'Summarize or recap one specific Rocket.Chat room or thread. Use when the user asks "what happened in #channel", "summarize this channel", "summarize this thread", "what did I miss in <room>", "recap the discussion in <room>", or "bring me up to speed on <channel>". Resolves the room, reads its recent window honestly, and summarizes with permalinks to key messages. Do NOT use for cross-room triage (use rocket-attention) or for finding a specific known message (use rocket-find).'
---

# rocket-catchup

Recap a single named room or thread. Bounded read, honest about how far back the cache reaches.

## Transport

- Prefer MCP tools when connected: `list_rooms`, `get_messages`, `list_threads`, `get_thread_messages`, `sync_history`.
- Otherwise shell out: `rocket-cli rooms --json`, `rocket-cli messages <room> --json`, `rocket-cli threads <room> --json`, `rocket-cli thread <id> --json`, `rocket-cli sync [room]`.
- Multi-server: `--profile <name>` (CLI) or `ROCKET_CLI_PROFILE` (MCP env).

## Workflow

1. **Resolve the room.** If the user named it precisely (`#general`, `@alice`, an id), pass it straight to `get_messages` — its `room` arg accepts id, `#channel`, `@username`, name, or display name. If the name is fuzzy or ambiguous, call `list_rooms` with `filter` (and `type` = `channel`/`group`/`dm`) first and confirm the match.
2. **Read the window.** Call `get_messages` (params: `room`, `count` 1-100 default 30, `before`/`after` ISO-8601 for paging, `includeSystem` default false). Newest-first. The response is an envelope with `room`, `syncedThrough`, `coverage`, and possibly `refreshing: true`.
3. **State coverage honestly.** Summarize only what `syncedThrough` / `coverage` actually span. Never imply you've read the whole channel's history if the cache only reaches back e.g. 30 messages / a few hours. If `refreshing: true`, note the data may be seconds stale.
4. **Go deeper only on demand.** Use `sync_history` ONLY when the user explicitly asks beyond the cached window ("the last month", "since last Tuesday"). Params: `room` (omit = most stale unread room — but here always pass the room), `depth` (1-5000, additional older messages). After it completes, re-read with `get_messages` using `before`/`after`. Never call `sync_history` ambiently to "be thorough".
5. **Handle threads when the content is thread-shaped.** Thread parents in `get_messages` carry a `replyCount` — those are conversations, not one-offs.
   - For a broad room recap with active discussions: `list_threads` (params: `room`, `count` 1-100 default 25, `text` filter) to enumerate active threads, then `get_thread_messages` (params: `threadId`, `count` 1-200 default 50) on the ones worth summarizing.
   - If the user pointed at a thread specifically ("summarize this thread"), go straight to `get_thread_messages` with its parent id (a pasted message link also works as `threadId`).
6. **Summarize with permalinks.** Group by topic/thread. For each key point, include the permalink to the anchoring message so the user can jump straight in. Call out decisions, open questions, and anything that names or pings the user.

## Anti-patterns

- Do NOT `sync_history` just to feel complete — recent window first; deepen only when asked.
- Do NOT page through hundreds of messages with repeated large `get_messages` calls when a thread/topic summary answers the ask.
- Do NOT overstate coverage. "Here's the last ~30 messages" beats implying you read everything.
- Do NOT omit permalinks on the messages you cite.
