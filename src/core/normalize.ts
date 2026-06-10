// Pure transforms: Rocket.Chat REST JSON -> SQLite rows, and rows -> compact
// LLM-facing records. No IO.
//
// Inputs are typed from the official `@rocket.chat/core-typings` shapes, but
// adapted to the *wire* reality of the REST API (see RcWire* types below).
// The official types describe the canonical server-side records; what actually
// arrives over REST is the `Serialized<T>` form (Date -> ISO string), and in
// practice it deviates further: required fields are sometimes omitted, dates
// occasionally arrive as the raw EJSON `{ $date: number }` (or epoch number)
// instead of an ISO string, and `editedAt` lives on `IEditedMessage` rather
// than the base `IMessage`. The implementation therefore keeps its defensive
// guards; the types document intent without lying about the payload.
import type {
  IMessage,
  ISubscription,
  MessageAttachment,
  Serialized,
} from '@rocket.chat/core-typings';
import type { CompactMessage, MessageRow, RoomRow } from './types.js';

/** RC serializes dates as ISO strings over REST, but some payloads carry the
 *  raw EJSON `{ $date: number }` form (we captured both live). Accept both;
 *  everything else -> null. */
type RcDate = string | number | { $date: number } | null | undefined;

/**
 * Wire shape of a Rocket.Chat message as it arrives over REST.
 *
 * Starts from `Serialized<IMessage>` (the official message type with dates
 * serialized to strings) but:
 *  - makes everything optional + the whole thing tolerant of partial payloads,
 *    since REST responses routinely omit fields the canonical type marks
 *    required;
 *  - re-widens the date fields to `RcDate` (REST mostly sends ISO strings, but
 *    we have observed `{ $date }` / epoch-number variants in the wild);
 *  - re-adds `editedAt` (a `Serialized<IEditedMessage>` field, absent from the
 *    base message type) so we can read it without a cast.
 */
export type RcWireMessage = Omit<Partial<Serialized<IMessage>>, 'ts' | 'tlm' | '_updatedAt'> & {
  ts?: RcDate;
  tlm?: RcDate;
  _updatedAt?: RcDate;
  // `editedAt` belongs to `Serialized<IEditedMessage>`, not the base message.
  editedAt?: RcDate;
};

/** Back-compat alias for the prior local input type name. */
export type RcMessage = RcWireMessage;

/** Wire shape of a single message attachment (the `MessageAttachment` union,
 *  serialized, made fully optional so we can probe variant-specific fields
 *  like `image_url` / `message_link` without narrowing the union first). */
export type RcWireAttachment = Partial<Serialized<MessageAttachment>>;

/** Wire shape of a subscription record over REST. Same partial/loose treatment
 *  as messages, with `_updatedAt` re-widened to `RcDate`. */
export type RcWireSubscription = Omit<Partial<Serialized<ISubscription>>, '_updatedAt'> & {
  _updatedAt?: RcDate;
};

/** Back-compat alias for the prior local input type name. */
export type RcSubscription = RcWireSubscription;

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

function attachmentLine(a: RcWireAttachment): string {
  const title = a.title?.trim();
  // `image_url` / `message_link` only exist on specific members of the
  // MessageAttachment union, so read them off the loose wire shape.
  const imageUrl = (a as { image_url?: string }).image_url;
  const messageLink = (a as { message_link?: string }).message_link;
  const titleLink = (a as { title_link?: string }).title_link;
  // Quote / reply attachments link back to another message.
  if (messageLink) {
    const quote = (a.text ?? a.description ?? '').trim();
    return `[quote] ${quote.slice(0, 80)}`;
  }
  if (imageUrl) {
    return `[image] ${title ?? imageUrl}`;
  }
  if (titleLink || (title && !a.text)) {
    return `[file] ${title ?? titleLink ?? ''}`.trimEnd();
  }
  // Plain fallback: title/text.
  const fallback = title ?? a.text?.trim() ?? a.description?.trim();
  return fallback ?? '[attachment]';
}

function attachmentsJson(attachments: RcWireAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  const lines = attachments.map(attachmentLine);
  return JSON.stringify(lines);
}

/** RC message JSON -> messages-table row. */
export function messageToRow(raw: RcWireMessage, rid: string): MessageRow {
  const u = raw.u ?? ({} as NonNullable<RcWireMessage['u']>);
  // `t` is a literal-union type, but a malformed payload could still send ''
  // — keep the defensive empty-string guard via a widened comparison.
  const systemType = raw.t != null && (raw.t as string) !== '' ? raw.t : null;
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
    attachments_json: attachmentsJson(raw.attachments as RcWireAttachment[] | undefined),
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

/** subscription -> rooms-table row (subset). */
export function subscriptionToRoomRow(sub: RcWireSubscription): RoomRow {
  return {
    rid: sub.rid ?? '',
    name: sub.name ?? null,
    fname: sub.fname ?? null,
    t: sub.t ?? '',
    unread: typeof sub.unread === 'number' ? sub.unread : 0,
    sub_updated_at: toIso(sub._updatedAt),
  };
}
