---
name: rocket-attention
description: Triage what needs the user's attention on Rocket.Chat. Use when the user asks "what needs my attention", "anything important on rocket", "catch me up", "what did I miss", "any mentions?", "any unread DMs", morning triage, or "am I being pinged anywhere". Surfaces mentions, unread DMs, unread thread replies, and unread channel messages, prioritized and deduplicated, each with a clickable permalink. Do NOT use for summarizing one specific room (use rocket-catchup) or searching for a known message (use rocket-find).
---

# rocket-attention

Answer "what needs MY attention right now" — the product's core job. Fast, prioritized, honest about freshness.

## Transport

- If the rocket-cli MCP server is connected, prefer its tools (`get_attention`, `get_unread`, `get_mentions`, `get_message_context`).
- Otherwise shell out: `rocket-cli attention --json`, `rocket-cli unread --json`, `rocket-cli mentions --json`.
- Multi-server: pass `--profile <name>` to the CLI, or rely on `ROCKET_CLI_PROFILE` in the MCP env block. Never guess a profile — if the user has several, ask which server.

## Workflow

1. **Pick the right tool for the ask.**
   - Broad ("what did I miss?", "catch me up", "anything important?") → `get_attention`. One call returns all four sections, prioritized and deduplicated.
   - Narrow → use the focused tool: "any mentions?" → `get_mentions`; "unread DMs / what's unread?" → `get_unread`.
2. **Call it once.** `get_attention` params: `sinceDays` (1-90, default 7, how far the mention search looks back), `limitPerSection` (1-100, default 30), `includeChannelWide` (default false — set true only if the user cares about @all/@here). Do not widen `sinceDays` unless the user implies a longer window.
3. **Honor `refreshing`.** If the envelope carries `refreshing: true`, the data was served from cache while a background sync runs and may be seconds stale. Say so briefly if exactness matters ("counts may be a beat behind"); for a casual triage glance just present it.
4. **Present priority-ordered**, in this sequence:
   1. Mentions of the user (most urgent)
   2. Unread DMs
   3. Unread thread replies
   4. Unread channel messages
   Within each section, group by room. Each item: who, a one-line gist, and its **permalink** (always included — this is the URL-loop contract). Rooms flagged `hiddenMentioned=true` (hide-unread-counter on but user is mentioned) still belong in the mentions section.
5. **Offer per-item follow-ups**, do not auto-execute:
   - "want the surrounding context?" → `get_message_context` on that message id.
   - "want to reply?" → hand off to the rocket-send workflow.

## Anti-patterns

- Do NOT dump the raw tool payload. Synthesize into a scannable, prioritized list.
- Do NOT fetch full room history (`get_messages` with big counts, or `sync_history`) to answer a triage question — triage tools fetch only the unread slice and are fast by design. Reaching for history here defeats the purpose.
- Do NOT call `sync_history` here, ever. Triage is always shallow.
- Do NOT claim "you have no unread anywhere" beyond what the envelope's `sinceDays` / coverage actually covered. State the window you looked at.
- Do NOT mark anything as read — these tools never clear badges, and neither should your narration imply they did.
