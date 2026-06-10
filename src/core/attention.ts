// One-call attention triage: the project's headline feature. Fuses the mentions
// view (collectMentions) and the unread view (collectUnread) into a single,
// prioritized, deduplicated digest of everything that needs the user's
// attention — mentions of them, unread DMs, unread thread replies, and unread
// channel messages. Every item carries the clickable permalink already minted
// by the upstream reports. Like both of its inputs, this module is PURE READ:
// it never marks anything as read.
import type { App } from './app.js';
import type { CompactMessage } from './types.js';
import { collectMentions, type MentionsReport } from './mentions.js';
import { collectUnread, type UnreadReport } from './unread.js';

type RoomType = 'channel' | 'group' | 'dm';

interface RoomRef {
  id: string;
  name: string;
  type: RoomType;
}

/** A single flattened attention item: a message plus the room it lives in. */
export interface AttentionItem {
  room: RoomRef;
  message: CompactMessage;
  /** Set on a mention that is ALSO unread — the message is surfaced once, in
   *  the (higher-priority) mentions section, with this flag instead of being
   *  duplicated into an unread section. */
  alsoUnread?: true;
}

/** A thread with unread replies, grouped under its parent for the digest. */
export interface AttentionThread {
  room: RoomRef;
  parent: CompactMessage;
  /** Unread replies under this parent, oldest first. */
  messages: CompactMessage[];
}

export interface AttentionReport {
  /** Messages mentioning the user (@username), newest first. Highest priority;
   *  a mention that is also unread appears ONLY here, flagged alsoUnread. */
  mentions: AttentionItem[];
  /** Unread messages in DM rooms (t='d'), excluding any already in mentions. */
  directUnreads: AttentionItem[];
  /** Unread thread replies across rooms, excluding replies already in mentions. */
  threadUnreads: AttentionThread[];
  /** Remaining unread channel/group messages, excluding any already in mentions. */
  channelUnreads: AttentionItem[];
  totals: {
    mentions: number;
    directUnreads: number;
    threadUnreads: number;
    channelUnreads: number;
    /** Total distinct items surfaced across all sections. */
    all: number;
  };
  /** ISO8601 lower bound applied to the mentions search (ts >= searchedSince). */
  searchedSince: string;
  /** ISO8601 timestamp this digest was assembled (caller clock). */
  generatedAt: string;
}

export interface CollectAttentionOptions {
  /** How far back the mentions search looks, in days. Default 7. */
  sinceDays?: number;
  /** Max items surfaced per section. Default 30. */
  limitPerSection?: number;
  /** Also match channel-wide @all / @here mentions. Default false. */
  includeChannelWide?: boolean;
}

/**
 * Assemble the attention digest.
 *
 * Pipeline:
 *   1. Run collectMentions + collectUnread in parallel. Both refresh
 *      subscriptions and sync the unread rooms; the per-room sync mutex makes
 *      the overlapping work safe and de-duplicated under concurrency.
 *   2. Build a set of mentioned message ids (the highest-priority section).
 *   3. mentions  -> flagged alsoUnread when the id is also unread.
 *   4. directUnreads  -> unread rooms with type 'dm', minus mentioned ids.
 *   5. threadUnreads  -> unread thread replies across rooms, minus mentioned ids.
 *   6. channelUnreads -> remaining unread (channel/group) main messages, minus
 *      mentioned ids.
 *   Each section is capped at limitPerSection (mentions keep newest; unread keep
 *   the upstream chronological order).
 */
export async function collectAttention(
  app: App,
  opts: CollectAttentionOptions = {},
): Promise<AttentionReport> {
  const sinceDays = Math.max(1, opts.sinceDays ?? 7);
  const limitPerSection = Math.max(1, opts.limitPerSection ?? 30);
  const includeChannelWide = opts.includeChannelWide ?? false;

  const [mentionsReport, unreadReport]: [MentionsReport, UnreadReport] =
    await Promise.all([
      collectMentions(app, {
        sinceDays,
        // Pull enough to fill the section after dedupe; cap below.
        limit: limitPerSection,
        includeChannelWide,
      }),
      collectUnread(app, { limitPerRoom: limitPerSection, includeThreads: true }),
    ]);

  // Build the set of all unread message ids (main + thread replies) so a
  // mention that is also unread can be flagged, and the set of mentioned ids so
  // unread sections can exclude them.
  const unreadIds = new Set<string>();
  for (const room of unreadReport.rooms) {
    for (const m of room.messages) unreadIds.add(m.id);
    for (const t of room.unreadThreads) {
      for (const reply of t.messages) unreadIds.add(reply.id);
    }
  }

  const mentions: AttentionItem[] = [];
  const mentionedIds = new Set<string>();
  for (const mr of mentionsReport.mentions) {
    for (const m of mr.messages) {
      mentionedIds.add(m.id);
      const item: AttentionItem = { room: mr.room, message: m };
      if (unreadIds.has(m.id)) item.alsoUnread = true;
      mentions.push(item);
    }
  }
  // mentionsReport already returns newest-first per room; the order across rooms
  // follows the report. Cap at the section limit.
  const cappedMentions = mentions.slice(0, limitPerSection);

  const directUnreads: AttentionItem[] = [];
  const channelUnreads: AttentionItem[] = [];
  const threadUnreads: AttentionThread[] = [];

  for (const room of unreadReport.rooms) {
    const target = room.room.type === 'dm' ? directUnreads : channelUnreads;
    for (const m of room.messages) {
      if (mentionedIds.has(m.id)) continue; // surfaced in mentions instead
      target.push({ room: room.room, message: m });
    }
    for (const t of room.unreadThreads) {
      const replies = t.messages.filter((r) => !mentionedIds.has(r.id));
      if (replies.length === 0) continue;
      threadUnreads.push({ room: room.room, parent: t.parent, messages: replies });
    }
  }

  const cappedDirect = directUnreads.slice(0, limitPerSection);
  const cappedThreads = threadUnreads.slice(0, limitPerSection);
  const cappedChannel = channelUnreads.slice(0, limitPerSection);

  const totals = {
    mentions: cappedMentions.length,
    directUnreads: cappedDirect.length,
    threadUnreads: cappedThreads.length,
    channelUnreads: cappedChannel.length,
    all: 0,
  };
  totals.all =
    totals.mentions +
    totals.directUnreads +
    totals.threadUnreads +
    totals.channelUnreads;

  return {
    mentions: cappedMentions,
    directUnreads: cappedDirect,
    threadUnreads: cappedThreads,
    channelUnreads: cappedChannel,
    totals,
    searchedSince: mentionsReport.searchedSince,
    generatedAt: new Date().toISOString(),
  };
}
