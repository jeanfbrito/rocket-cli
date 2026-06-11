// Read-only unread collection, shared by the CLI `unread` command and the MCP
// `get_unread` tool. Slices exactly the messages that arrived since the user
// last read each room in the Rocket.Chat UI, using the server-maintained
// per-room last-read watermark (ISubscription.ls) and the unread thread-parent
// ids (ISubscription.tunread).
//
// This module NEVER marks anything as read: it does not call subscriptions.read
// (or any other read/markRead endpoint). It only refreshes subscriptions
// (subscriptions.get), syncs rooms/threads (history / syncMessages /
// getThreadMessages), and reads the local cache. The whole flow is a pure view.
import type { App } from './app.js';
import type { CompactMessage, MessageRow, RoomRow } from './types.js';
import { rowToCompactWithLink } from './normalize.js';

/** Map a stored room type ('c'|'p'|'d') to a human/LLM-facing label. */
function roomTypeLabel(t: string): 'channel' | 'group' | 'dm' {
  switch (t) {
    case 'p':
      return 'group';
    case 'd':
      return 'dm';
    default:
      return 'channel';
  }
}

export interface UnreadThread {
  /** The thread parent message (compact). */
  parent: CompactMessage;
  /** Unread replies under this parent (ts > room.ls), oldest first. */
  messages: CompactMessage[];
}

export interface UnreadRoom {
  room: { id: string; name: string; type: 'channel' | 'group' | 'dm' };
  /** The server's unread count for the room (subscription.unread). On servers
   *  whose Unread_Count is the default 'user_and_group_mentions_only' this stays
   *  0 for plain (non-mention) activity even though the room is unread — see
   *  `activityOnly`. */
  unreadCount: number;
  /**
   * True when the room is surfaced only by its sidebar `alert` flag: the server
   * unread *count* is 0 and there are no unread threads, but the room was
   * touched since the last read (e.g. a plain channel message on a
   * mentions-only server). The sliced `messages` are still the exact messages
   * after the last-read watermark; the count is just not maintained by the
   * server. Lets the UI label these honestly instead of printing "0 unread".
   */
  activityOnly: boolean;
  /**
   * True when this room is hidden in the UI (its "Hide unread counter" setting
   * is on) but surfaced anyway because the user is mentioned in it — the one
   * exception the Rocket.Chat sidebar keeps for hidden rooms. Lets the report
   * label it distinctly ("hidden room, mentioned") instead of as a normal
   * unread. Always false for ordinary rooms, and (when `--all`/includeHidden is
   * used) for hidden rooms pulled in without a mention.
   */
  hiddenMentioned: boolean;
  /**
   * Whether `messages` was sliced exactly (ts > ls) or approximated. When the
   * room has no last-read watermark (`ls` is null — never opened), we fall back
   * to the newest `unreadCount` messages as a best-effort approximation.
   */
  approximate: boolean;
  /** Unread main-channel messages (ts > ls), oldest first, capped at limit. */
  messages: CompactMessage[];
  /** Threads with unread replies, from subscription.tunread. */
  unreadThreads: UnreadThread[];
}

export interface UnreadReport {
  rooms: UnreadRoom[];
  totals: { rooms: number; messages: number; threads: number };
  /** True when a background sync was kicked for one or more rooms while
   *  assembling this report — the data is current as of the local cache but a
   *  fresher delta is landing. Lets the client label the answer honestly
   *  ("data may be seconds stale; refreshing in background"). */
  refreshing: boolean;
}

export interface CollectUnreadOptions {
  /** Max main-channel messages to surface per room. Default 50. */
  limitPerRoom?: number;
  /** Whether to include unread thread replies. Default true. */
  includeThreads?: boolean;
  /**
   * Include rooms whose "Hide unread counter" setting is on, with the legacy
   * (pre-parity) behavior — every room with any unread signal, regardless of
   * the hide flag. Default false = UI parity (hidden rooms appear only via the
   * mention exception). Backs the CLI `--all` flag / MCP `includeHidden` input.
   */
  includeHidden?: boolean;
}

/** Parse a room's stored tunread JSON into a string[] of parent ids. */
function parseTunread(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Collect everything unread across the user's rooms, read-only.
 *
 * Pipeline per call:
 *   1. rooms.refresh() — force-pull fresh subscriptions (bypass the 5-min TTL);
 *      unread state is the entire point, so we always want the latest watermarks.
 *   2. db.findUnreadRooms() — rooms with unread > 0 OR alert OR a non-empty
 *      tunread (mirrors the RC sidebar "Unread" predicate; `alert` catches plain
 *      unread messages that don't bump the count on mentions-only servers).
 *   3. per room: ensureRoomSynced(rid), then slice ts > ls (exact) or newest-N
 *      (approximate, when ls is null) from the local timeline.
 *   4. per unread thread parent: ensureThreadLoaded(parent), then slice replies
 *      with ts > ls.
 */
export async function collectUnread(
  app: App,
  opts: CollectUnreadOptions = {},
): Promise<UnreadReport> {
  const limit = Math.max(1, opts.limitPerRoom ?? 50);
  const includeThreads = opts.includeThreads ?? true;
  const includeHidden = opts.includeHidden ?? false;

  // Force fresh subscription data: unread watermarks must be current.
  await app.rooms.refresh();

  const unreadRooms = app.db.findUnreadRooms({ includeHidden });
  const rooms: UnreadRoom[] = [];
  let totalMessages = 0;
  let totalThreads = 0;
  let refreshing = false;

  for (const room of unreadRooms) {
    const collected = await collectRoom(app, room, limit, includeThreads);
    totalMessages += collected.room.messages.length;
    totalThreads += collected.room.unreadThreads.length;
    if (collected.refreshing) refreshing = true;
    rooms.push(collected.room);
  }

  return {
    rooms,
    totals: { rooms: rooms.length, messages: totalMessages, threads: totalThreads },
    refreshing,
  };
}

async function collectRoom(
  app: App,
  room: RoomRow,
  limit: number,
  includeThreads: boolean,
): Promise<{ room: UnreadRoom; refreshing: boolean }> {
  // Shallow sync: the unread payload is just messages after the last-read
  // watermark, so for a never-synced room we fetch only that window instead of
  // the full backfill. `ls` is the exact lower bound; with no watermark (room
  // never opened) fall back to the last 24h, which bounds the fetch while still
  // covering recent activity. An already-synced room serves from cache and
  // revalidates the delta in the background (refreshing = true).
  const since =
    room.ls ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const outcome = await app.sync.ensureRoomSyncedShallow(room.rid, since);

  const baseUrl = app.config.url;
  const toCompact = (r: MessageRow): CompactMessage =>
    rowToCompactWithLink(r, room, baseUrl);

  const ls = room.ls ?? null;
  const approximate = ls == null;
  // Activity-only: the room shows up purely on its sidebar `alert` flag — the
  // server keeps no unread count for it (mentions-only Unread_Count) and there
  // are no unread threads. We still slice the real messages after `ls`, but the
  // numeric count is not meaningful, so surface a flag for honest labeling.
  const parentIdsForFlag = parseTunread(room.tunread);
  const activityOnly =
    room.unread === 0 && (room.alert ?? 0) === 1 && parentIdsForFlag.length === 0;

  // Exact: messages strictly newer than the last-read watermark. getTimeline
  // returns DESC (newest first); reverse for chronological display.
  // Fallback: no watermark -> newest `unreadCount` (capped at limit), since we
  // cannot know precisely which messages are unread.
  let mainRows;
  if (ls != null) {
    mainRows = app.db.getTimeline(room.rid, { limit, afterTs: ls });
  } else {
    const approxCount = Math.min(limit, Math.max(1, room.unread));
    mainRows = app.db.getTimeline(room.rid, { limit: approxCount });
  }
  const messages = [...mainRows].reverse().map(toCompact);

  const unreadThreads: UnreadThread[] = [];
  if (includeThreads) {
    const parentIds = parentIdsForFlag;
    for (const tmid of parentIds) {
      const parent = await app.sync.ensureThreadLoaded(tmid);
      // Unread replies: ts > ls when we have a watermark, else all loaded
      // replies (approximation, same rationale as the main timeline).
      const replies = app.db.getThreadMessages(tmid);
      const unreadReplies = (ls != null
        ? replies.filter((r) => r.ts > ls)
        : replies
      ).map(toCompact);
      unreadThreads.push({ parent: toCompact(parent), messages: unreadReplies });
    }
  }

  return {
    room: {
      room: {
        id: room.rid,
        name: room.name ?? room.fname ?? room.rid,
        type: roomTypeLabel(room.t),
      },
      unreadCount: room.unread,
      activityOnly,
      // hidden_mentioned is a computed column set by findUnreadRooms only for a
      // hidden room surfaced via the mention exception (default predicate). In
      // the includeHidden path it is also 1 for any hidden room, but those have
      // no mention — the flag is only meaningful under UI-parity, where it is
      // exactly "hidden but mentioned". Default false for ordinary rooms.
      hiddenMentioned: (room.hidden_mentioned ?? 0) === 1,
      approximate,
      messages,
      unreadThreads,
    },
    refreshing: outcome.refreshing,
  };
}
