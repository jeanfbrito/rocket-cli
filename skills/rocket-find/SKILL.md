---
name: rocket-find
description: Search Rocket.Chat for a specific message, link, file, or who said something. Use when the user asks "find that message about X", "who said Y", "search rocket for Z", "find the link someone posted", "where did we discuss <topic>", or "find the file <name> someone shared". Runs full-text search across all locally cached rooms first (instant), with a room-scoped server fallback for thin results. Do NOT use for general triage (use rocket-attention) or summarizing a whole room (use rocket-catchup).
---

# rocket-find

Locate a known-ish message across rooms. Local full-text first; server fallback only when scoped to a room.

## Transport

- Prefer MCP when connected: `search_messages`, then `get_message_context` to expand a hit.
- Otherwise shell out: `rocket-cli search <query> --json` (add `--room <room>` to scope), `rocket-cli context <messageId> --json`.
- Multi-server: `--profile <name>` (CLI) or `ROCKET_CLI_PROFILE` (MCP env).

## Search semantics (FTS5 — important)

- Query terms are split on whitespace and **ANDed** together — every term must appear. Fewer, more distinctive terms beat a long phrase.
- A **trailing `*`** on a term is a prefix match (`deploy*` matches deploy/deployed/deployment). Use it when the user gives a stem.
- Operators like `AND`/`OR`/`NOT`/`NEAR` and punctuation are treated as literal text, not syntax — you can't compose boolean queries; pick good terms instead.
- **Cross-room search is local-only.** Without a `room`, search runs purely over the local FTS cache across ALL cached rooms (instant, no network). The server fallback (which reaches uncached history) fires ONLY when you pass a `room` AND local hits are thin.

## Workflow

1. **Run a cross-room search first.** `search_messages` params: `query` (required), `room` (optional), `author` (optional username filter), `limit` (1-100, default 20). Start without `room` so all cached rooms are covered. Choose 1-3 distinctive terms from the user's ask; add a trailing `*` to stems.
2. **Read the result envelope.** It carries each hit's `snippet` and a `source` (`local` or `server`), plus `localOnly` and an optional `note` explaining thin or degraded results.
3. **If hits are thin AND the user implies a room**, re-run scoped to that room (`room: "#whatever"`) to engage the server-side fallback that reaches uncached history. If the user gave no room hint and results are thin, tell them cross-room search is cache-only and offer to scope to a likely room (which enables server search there).
4. **Use `author`** when the user says "who said X" or "find what <person> posted about Y" — filter by their username.
5. **Present hits** ranked, each with: room, author, the snippet, and the **permalink**. Keep it scannable.
6. **Offer to expand.** "Want the conversation around that one?" → `get_message_context` (params: `messageId` — a hit's id or a pasted link; `before` 0-50 default 10; `after` 0-50 default 5). A thread reply pivots to its whole thread automatically.

## Anti-patterns

- Do NOT expect cross-room server search — without a `room`, it's local cache only. Don't promise to search "everything on the server" cross-room.
- Do NOT stuff the whole user sentence into `query` as one phrase — split into distinctive ANDed terms.
- Do NOT fabricate operators; FTS treats AND/OR/NOT as literals.
- Do NOT drop permalinks from the hits you surface.
