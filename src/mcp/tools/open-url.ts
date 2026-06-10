import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import type { CompactMessage, MessageRow, RoomRow } from '../../core/types.js';
import { messageToRow, rowToCompactWithLink } from '../../core/normalize.js';
import { looksLikeUrl, parseRocketChatUrl } from '../../core/urls.js';
import { fail, ok, roomTypeLabel } from './shared.js';

/**
 * The universal inbound entry point. A human pastes ANY Rocket.Chat web link —
 * a message, a thread, or a plain channel — and this tool figures out what it
 * points at, returns the relevant content, and hands back the ids the agent
 * needs to act on it next (reply in thread, react, send to the room).
 *
 * Three modes, decided from the parsed URL + the target message:
 *   - 'message': link targets a top-level message -> the message plus the
 *      surrounding timeline (count messages, chronological).
 *   - 'thread':  link targets a thread reply (has tmid) or a thread parent
 *      (tcount > 0) -> the full thread, parent first.
 *   - 'room':    link is just a channel/group/DM -> recent timeline.
 */

interface Affordances {
  /** tmid to pass as send_message's threadId to reply in this thread. */
  replyInThread?: string;
  /** message id to pass to add_reaction. */
  reactTo?: string;
  /** room name to pass to send_message / get_messages. */
  room: string;
}

interface OpenUrlResult {
  mode: 'message' | 'thread' | 'room';
  room: { id: string; name: string; type: 'channel' | 'group' | 'dm' };
  target?: CompactMessage;
  messages: CompactMessage[];
  affordances: Affordances;
}

export function registerOpenUrlTool(server: McpServer, app: App): void {
  server.registerTool(
    'open_url',
    {
      description:
        'Open any Rocket.Chat URL the user pastes — a message link, thread, ' +
        'or channel — and return its content plus the ids needed to act on ' +
        'it (reply, react, send).',
      inputSchema: {
        url: z
          .string()
          .describe('any Rocket.Chat link: message, thread, or channel'),
        count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe('How many messages of context to return (1-100, default 20).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ url, count }) => {
      try {
        if (!looksLikeUrl(url)) {
          return fail(
            new Error(
              'open_url expects a pasted Rocket.Chat web link (e.g. ' +
                `${app.config.url}/channel/general?msg=<id>). Got: "${url}".`,
            ),
          );
        }
        const parsed = parseRocketChatUrl(app.config.url, url);
        if (!parsed) {
          return fail(
            new Error(
              `URL is not a Rocket.Chat link on ${app.config.url}. Accepted ` +
                'shapes: /channel/<name>, /group/<name>, /direct/<rid>, ' +
                'optionally with ?msg=<id> or /thread/<tmid>.',
            ),
          );
        }

        const room = await app.rooms.resolve(parsed.roomRef);

        if (parsed.messageId !== undefined) {
          return await openMessage(app, room, parsed.messageId, count);
        }
        return await openRoom(app, room, count);
      } catch (err) {
        return fail(err);
      }
    },
  );
}

/** Build the room descriptor portion of the envelope. */
function roomDescriptor(room: RoomRow): OpenUrlResult['room'] {
  return {
    id: room.rid,
    name: room.name ?? room.fname ?? room.rid,
    type: roomTypeLabel(room.t),
  };
}

/** Resolve a message by id: prefer the local cache, fall back to the server and
 *  upsert what we learn so subsequent reads are local. */
async function fetchMessage(app: App, room: RoomRow, messageId: string): Promise<MessageRow | null> {
  const local = app.db.getMessage(messageId);
  if (local) return local;
  const res = await app.rc.getMessage({ msgId: messageId });
  if (!res.message || !res.message._id) return null;
  const rid = res.message.rid ?? room.rid;
  const row = messageToRow(res.message, rid);
  app.db.upsertMessages([row]);
  return row;
}

/** Open a link that targets a specific message: thread vs message mode. */
async function openMessage(
  app: App,
  room: RoomRow,
  messageId: string,
  count: number,
): Promise<ReturnType<typeof ok>> {
  // Ensure the room is synced so the surrounding timeline is populated, then
  // (re)read the target — sync may have filled in tcount/tmid.
  await app.sync.ensureRoomSynced(room.rid);
  let target = await fetchMessage(app, room, messageId);
  if (!target) {
    return fail(
      new Error(
        `Message "${messageId}" not found in ${room.name ?? room.rid}.`,
      ),
    );
  }

  const link = (r: MessageRow): CompactMessage =>
    rowToCompactWithLink(r, room, app.config.url);

  // Thread reply -> open its parent thread. Thread parent -> open its own.
  const threadParentId =
    target.tmid != null && target.tmid !== ''
      ? target.tmid
      : (target.tcount ?? 0) > 0
        ? target.id
        : null;

  if (threadParentId !== null) {
    const parent = await app.sync.ensureThreadLoaded(threadParentId);
    const replies = app.db.getThreadMessages(threadParentId, { limit: count });
    target = app.db.getMessage(messageId) ?? target;
    const result: OpenUrlResult = {
      mode: 'thread',
      room: roomDescriptor(room),
      target: link(target),
      messages: [parent, ...replies].map(link),
      affordances: {
        replyInThread: threadParentId,
        reactTo: target.id,
        room: room.name ?? room.fname ?? room.rid,
      },
    };
    return ok(result);
  }

  // Plain message: return it with surrounding timeline context. Pull `count`
  // messages centered on the target (older + newer), then order chronologically.
  const half = Math.max(1, Math.floor(count / 2));
  const older = app.db.getTimeline(room.rid, { limit: half, beforeTs: target.ts });
  const newer = app.db.getTimeline(room.rid, { limit: half, afterTs: target.ts });
  // getTimeline returns DESC; assemble chronological: older(asc) + target + newer(asc).
  const window: MessageRow[] = [
    ...[...older].reverse(),
    target,
    ...[...newer].reverse(),
  ];

  const result: OpenUrlResult = {
    mode: 'message',
    room: roomDescriptor(room),
    target: link(target),
    messages: window.map(link),
    affordances: {
      reactTo: target.id,
      room: room.name ?? room.fname ?? room.rid,
    },
  };
  return ok(result);
}

/** Open a plain room link: recent timeline, room mode. */
async function openRoom(
  app: App,
  room: RoomRow,
  count: number,
): Promise<ReturnType<typeof ok>> {
  await app.sync.ensureRoomSynced(room.rid);
  const rows = app.db.getTimeline(room.rid, { limit: count });
  // getTimeline is newest-first; present chronologically.
  const ordered = [...rows].reverse();
  const result: OpenUrlResult = {
    mode: 'room',
    room: roomDescriptor(room),
    messages: ordered.map((r) => rowToCompactWithLink(r, room, app.config.url)),
    affordances: {
      room: room.name ?? room.fname ?? room.rid,
    },
  };
  return ok(result);
}
