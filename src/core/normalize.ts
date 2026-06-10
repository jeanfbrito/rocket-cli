// Pure transforms: Rocket.Chat REST JSON -> SQLite rows, and rows -> compact
// LLM-facing records. No IO, no imports of core-typings (kept intentionally
// loose: all RC fields optional, defensive against payload variance).
import type { CompactMessage, MessageRow, RoomRow } from './types.js';

/** RC serializes dates as ISO strings over REST, but some payloads carry the
 *  raw EJSON `{ $date: number }` form. Accept both; everything else -> null. */
type RcDate = string | number | { $date: number } | null | undefined;

interface RcUser {
  _id?: string;
  username?: string;
  name?: string;
}

interface RcAttachment {
  title?: string;
  text?: string;
  description?: string;
  image_url?: string;
  title_link?: string;
  message_link?: string; // present on quote/reply attachments
}

/** Minimal, loose shape of a Rocket.Chat message over REST. */
export interface RcMessage {
  _id?: string;
  rid?: string;
  msg?: string;
  ts?: RcDate;
  u?: RcUser;
  tmid?: string;
  tcount?: number;
  tlm?: RcDate;
  editedAt?: RcDate;
  t?: string; // system message type when present
  attachments?: RcAttachment[];
  _updatedAt?: RcDate;
}

/** Convert any accepted RC date form to an ISO8601 string, or null. */
export function toIso(d: RcDate): string | null {
  if (d == null) return null;
  if (typeof d === 'string') {
    // Already ISO (or any parseable date string) — normalize if parseable,
    // otherwise keep the original string (RC REST gives ISO already).
    const ms = Date.parse(d);
    return Number.isNaN(ms) ? d : new Date(ms).toISOString();
  }
  if (typeof d === 'number') return new Date(d).toISOString();
  if (typeof d === 'object' && typeof d.$date === 'number') {
    return new Date(d.$date).toISOString();
  }
  return null;
}

function attachmentLine(a: RcAttachment): string {
  const title = a.title?.trim();
  // Quote / reply attachments link back to another message.
  if (a.message_link) {
    const quote = (a.text ?? a.description ?? '').trim();
    return `[quote] ${quote.slice(0, 80)}`;
  }
  if (a.image_url) {
    return `[image] ${title ?? a.image_url}`;
  }
  if (a.title_link || (title && !a.text)) {
    return `[file] ${title ?? a.title_link ?? ''}`.trimEnd();
  }
  // Plain fallback: title/text.
  const fallback = title ?? a.text?.trim() ?? a.description?.trim();
  return fallback ?? '[attachment]';
}

function attachmentsJson(attachments: RcAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  const lines = attachments.map(attachmentLine);
  return JSON.stringify(lines);
}

/** RC message JSON -> messages-table row. */
export function messageToRow(raw: RcMessage, rid: string): MessageRow {
  const u = raw.u ?? {};
  const systemType = raw.t != null && raw.t !== '' ? raw.t : null;
  return {
    id: raw._id ?? '',
    rid: raw.rid ?? rid,
    author_id: u._id ?? null,
    author_username: u.username ?? null,
    author_name: u.name ?? null,
    text: raw.msg ?? '',
    ts: toIso(raw.ts) ?? '',
    tmid: raw.tmid ?? null,
    tcount: typeof raw.tcount === 'number' ? raw.tcount : null,
    tlm: toIso(raw.tlm),
    edited_at: toIso(raw.editedAt),
    system_type: systemType,
    attachments_json: attachmentsJson(raw.attachments),
    deleted: 0,
    updated_at: toIso(raw._updatedAt),
  };
}

/** messages-table row -> compact LLM record. Omits empty / null fields. */
export function rowToCompact(row: MessageRow): CompactMessage {
  const compact: CompactMessage = {
    id: row.id,
    author: row.author_username ?? row.author_name ?? row.author_id ?? '',
    text: row.text,
    time: row.ts,
  };
  if (row.tmid) compact.threadId = row.tmid;
  if (typeof row.tcount === 'number' && row.tcount > 0) compact.replyCount = row.tcount;
  if (row.tlm) compact.lastReplyAt = row.tlm;
  if (row.edited_at) compact.edited = true;
  if (row.system_type) compact.system = row.system_type;
  if (row.attachments_json) {
    try {
      const arr = JSON.parse(row.attachments_json) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        compact.attachments = arr.map(String);
      }
    } catch {
      // Malformed stored JSON — skip attachments rather than throw.
    }
  }
  return compact;
}

/** Loose shape of a Rocket.Chat subscription record. */
export interface RcSubscription {
  rid?: string;
  name?: string;
  fname?: string;
  t?: string; // 'c' | 'p' | 'd'
  unread?: number;
  _updatedAt?: RcDate;
}

/** subscription -> rooms-table row (subset). */
export function subscriptionToRoomRow(sub: RcSubscription): RoomRow {
  return {
    rid: sub.rid ?? '',
    name: sub.name ?? null,
    fname: sub.fname ?? null,
    t: sub.t ?? '',
    unread: typeof sub.unread === 'number' ? sub.unread : 0,
    sub_updated_at: toIso(sub._updatedAt),
  };
}
