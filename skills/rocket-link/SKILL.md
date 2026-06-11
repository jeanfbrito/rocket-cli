---
name: rocket-link
description: Open a Rocket.Chat URL the user pasted and show its content plus how to act on it. Use whenever the user pastes a rocket.chat link — a message permalink, a thread link, or a channel link (e.g. https://chat.example.com/channel/general?msg=abc123) — and asks "what's this", "open this", "what does this say", or just drops the URL. Returns the entity (message / thread / channel) with the ids needed to reply, react, or read more. This is the inbound half of the URL loop.
---

# rocket-link

Resolve any pasted Rocket.Chat link into content + action affordances. Keep it short — open, show, offer.

## Transport

- Prefer MCP when connected: `open_url`.
- Otherwise shell out: `rocket-cli open <url> --json`.
- Multi-server: `--profile <name>` (CLI) or `ROCKET_CLI_PROFILE` (MCP env). The link's host should match the active profile's server; if it points at a different server than the connected one, say so.

## Workflow

1. **Pass the URL straight through.** `open_url` params: `url` (any Rocket.Chat link — message, thread, or channel), `count` (1-100, default 20, how many messages of context). It accepts message permalinks, thread links, and channel links alike — you do not need to classify the link yourself first.
2. **Branch on the returned entity type:**
   - **Message** → present the message and its surrounding context; offer `get_message_context` for a wider window.
   - **Thread** → present the thread (parent + replies); offer `get_thread_messages` for the full thread if truncated.
   - **Channel / room** → present recent messages; offer the rocket-catchup workflow for a summary.
3. **Always surface the affordances the tool returns** — the ids needed to reply, react, or send. Offer concrete next steps: "reply in this thread?", "react?", "summarize the channel?". Route any send/react/reply through the rocket-send workflow.
4. **Include the permalink** of the resolved entity in your reply.

## Notes

- If `open_url` rejects the input as not-a-link, the user likely pasted plain text or a partial id — fall back: a bare message id can go to `get_message_context` / `get_thread_messages`; a room name to the rocket-catchup workflow.
- Honor `refreshing: true` if present (cache served while a background sync runs; data may be seconds stale).

## Anti-patterns

- Do NOT try to parse the URL yourself or guess the entity type before calling — `open_url` does the resolution.
- Do NOT take any write action (reply/react) from this skill without explicit user confirmation — hand off to rocket-send.
- Do NOT dump the raw payload; present the content and the next-step affordances.
