---
name: rocket-send
description: 'Send a message, reply, reaction, or file upload to Rocket.Chat. Use when the user asks "reply to <message/thread>", "send a message to #channel", "DM <person>", "post in <room>", "react with <emoji>", "thumbs-up that", or "upload this file to <room>". Resolves the target, confirms before anything user-visible is sent, then posts and returns the new message''s permalink. Degrades to drafting text when the profile is read-only. Do NOT use for reading or searching.'
---

# rocket-send

Write actions: send, reply, react, upload. Confirm before anything hits the server. Always return the resulting permalink.

## Transport

- Prefer MCP when connected: `send_message`, `add_reaction`, `upload_file`, plus `list_custom_emojis` / `get_custom_emoji` for emoji resolution and `open_url` to resolve a pasted target.
- Otherwise shell out: `rocket-cli send <target> [text…] --json`, `rocket-cli upload <room> <file> --json`. (Reactions are MCP-first; if no `react` CLI subcommand is available, fall back to drafting.)
- Multi-server: `--profile <name>` (CLI) or `ROCKET_CLI_PROFILE` (MCP env). Confirm which server when ambiguous.

## Read-only degradation (check first)

The write tools (`send_message`, `add_reaction`, `upload_file`) are only registered when the profile permits them. On a read-only profile they are absent. If a write tool is unavailable (not in the tool list, or the call fails with a permission/capability error), do NOT keep retrying — switch to **drafting**: compose the exact message and tell the user to send it themselves (or switch profiles). Never silently fail.

## Workflow

1. **Resolve the target.**
   - `#channel`, `@username` (opens/uses a DM), a room name, or a room id all work directly as the `target` / `room` arg.
   - If the user pasted a message or thread link, run `open_url` to extract the room and the message/thread id.
2. **Decide thread vs. room.** When replying to a thread message, reply IN the thread: pass that thread parent's id as `threadId` (also `tmid` in raw API terms). Prefer in-thread replies when responding to anything thread-shaped, rather than posting to the room root.
3. **Confirm before sending.** Show the user the exact target and exact text and get a go-ahead BEFORE calling any write tool — UNLESS the user already supplied both exact text and an unambiguous target, in which case proceed.
4. **Send the right action:**
   - Message / reply → `send_message` (params: `target`, `text` non-empty, `threadId?`). Custom emoji in text use `:name:` — confirm the name via `list_custom_emojis` if unsure.
   - Reaction → `add_reaction` (params: `messageId` — an id or a pasted message link; `emoji` — `thumbsup` or `:thumbsup:`; `remove` default false to withdraw). For a custom emoji, resolve the name first via `list_custom_emojis` / `get_custom_emoji`.
   - File → `upload_file` (params: `room`, `filePath` absolute, `text?` caption, `threadId?`, `fileName?`).
5. **Return the permalink.** The sent/uploaded message is written into the local cache and the response carries its id/permalink — surface that link so the user can jump to it. This closes the URL loop.

## Anti-patterns

- NEVER invent or embellish message text beyond what the user approved. Send exactly what was confirmed.
- Do NOT post to the room root when the context is a thread — reply in-thread via `threadId`.
- Do NOT repeatedly retry a write that failed on a read-only profile — degrade to drafting.
- Do NOT skip confirmation for user-visible sends unless the user already gave exact text + target.
