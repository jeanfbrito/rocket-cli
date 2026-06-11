// Read-only cross-room mention triage: "what needs MY attention". Finds every
// cached message that mentions the user (@username), grouped by room, each with
// a clickable permalink. Shared by the CLI `mentions` command and the MCP
// `get_mentions` tool.
//
// HONEST SEMANTIC: this searches the LOCAL cache of messages. A full server
// scan of every room would be far too slow, so we only freshen the rooms that
// currently have unread activity (mentions overwhelmingly live where unread
// lives) — see the freshening step below. Messages in rooms that are fully read
// and not re-synced since they arrived are matched from whatever is already
// cached. This module NEVER marks anything as read.
import type { App } from './app.js';
import type { CompactMessage, MessageRow, RoomRow } from './types.js';
import { rowToCompactWithLink } from './normalize.js';

/** Meta key caching the resolved username for config.userId. */
const MY_USERNAME = 'my_username';

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

export interface MentionRoom {
  room: { id: string; name: string; type: 'channel' | 'group' | 'dm' };
  /** Messages in this room mentioning the user, newest first, with links. */
  messages: CompactMessage[];
}

export interface MentionsReport {
  mentions: MentionRoom[];
  totals: { rooms: number; messages: number };
  /** ISO8601 lower bound applied to the search (ts >= searchedSince). */
  searchedSince: string;
  /** True when a background sync was kicked while freshening an unread room —
   *  the answer reflects the local cache and a fresher delta is landing. */
  refreshing: boolean;
}

export interface CollectMentionsOptions {
  /** How far back to look, in days. Default 7. */
  sinceDays?: number;
  /** Max total messages to surface across all rooms. Default 50. */
  limit?: number;
  /** Also match channel-wide @all / @here mentions. Default false. */
  includeChannelWide?: boolean;
}

/**
 * Resolve the user's own username, caching it in meta. On a miss, calls
 * users.info for config.userId and stores the result so subsequent calls (and
 * processes) skip the round-trip.
 */
async function resolveMyUsername(app: App): Promise<string> {
  const cached = app.db.getMeta(MY_USERNAME);
  if (cached) return cached;

  const res = await app.rc.userInfo({ userId: app.config.userId });
  const username = res.user?.username;
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error(
      `Could not resolve a username for user id "${app.config.userId}" ` +
        '(users.info returned no username).',
    );
  }
  app.db.setMeta(MY_USERNAME, username);
  return username;
}

/**
 * Collect every cached message that mentions the user across all rooms.
 *
 * Pipeline:
 *   1. Resolve my username (meta cache, else users.info).
 *   2. rooms.refresh() — fresh subscriptions, so unread state is current.
 *   3. ensureRoomSynced() for each room with unread activity — mentions live
 *      where unread lives; a full --all sync would be too slow.
 *   4. db.findMentions([myUsername, ...channel-wide]) since the watermark.
 *   5. Group by room, attach permalinks, total up.
 */
export async function collectMentions(
  app: App,
  opts: CollectMentionsOptions = {},
): Promise<MentionsReport> {
  const sinceDays = Math.max(1, opts.sinceDays ?? 7);
  const limit = Math.max(1, opts.limit ?? 50);
  const includeChannelWide = opts.includeChannelWide ?? false;

  const myUsername = await resolveMyUsername(app);

  // Fresh subscriptions, then freshen the rooms where unread activity lives —
  // mentions almost always arrive in a room that now shows unread.
  await app.rooms.refresh();
  let refreshing = false;
  // Freshen with includeHidden=true: mentions always matter, so a room whose
  // "Hide unread counter" setting is on must still have its window pulled for
  // the mention search — the UI-parity default predicate would skip a hidden
  // room without a server-side mention count, but a freshly-arrived mention
  // can live there before the count propagates. findMentions then matches the
  // actual @username in the cached text, independent of the hide flags.
  for (const room of app.db.findUnreadRooms({ includeHidden: true })) {
    // Shallow freshening (same rationale as collectUnread): a never-synced
    // unread room only needs the window after its last-read watermark for
    // triage; the FTS query bounds the mention search itself. `ls` is the exact
    // lower bound, with a 24h fallback when the room has never been opened. An
    // already-synced room serves from cache and revalidates in the background.
    const since =
      room.ls ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const outcome = await app.sync.ensureRoomSyncedShallow(room.rid, since);
    if (outcome.refreshing) refreshing = true;
  }

  const searchedSince = new Date(
    Date.now() - sinceDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const usernames = includeChannelWide
    ? [myUsername, 'all', 'here']
    : [myUsername];

  const rows = app.db.findMentions(usernames, { sinceTs: searchedSince, limit });

  // Group by room, preserving the newest-first order from the query.
  const baseUrl = app.config.url;
  const byRoom = new Map<string, { room: RoomRow; rows: MessageRow[] }>();
  for (const row of rows) {
    let bucket = byRoom.get(row.rid);
    if (!bucket) {
      const room = app.db.getRoom(row.rid);
      if (!room) continue; // orphan message without a cached room — skip.
      bucket = { room, rows: [] };
      byRoom.set(row.rid, bucket);
    }
    bucket.rows.push(row);
  }

  const mentions: MentionRoom[] = [];
  let totalMessages = 0;
  for (const { room, rows: roomRows } of byRoom.values()) {
    const messages = roomRows.map((r) =>
      rowToCompactWithLink(r, room, baseUrl),
    );
    totalMessages += messages.length;
    mentions.push({
      room: {
        id: room.rid,
        name: room.name ?? room.fname ?? room.rid,
        type: roomTypeLabel(room.t),
      },
      messages,
    });
  }

  return {
    mentions,
    totals: { rooms: mentions.length, messages: totalMessages },
    searchedSince,
    refreshing,
  };
}
