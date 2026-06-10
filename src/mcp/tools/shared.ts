// Shared conventions for MCP tool handlers: compact JSON success/error
// envelopes and the read-tool room envelope builder. Keeping these here means
// every tool returns the same shape, so the LLM client sees a consistent
// contract across all registered tools.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { rowToCompactWithLink } from '../../core/normalize.js';
import type { CompactMessage, MessageRow, RoomRow } from '../../core/types.js';

/** Success: compact JSON (no indentation — every byte costs the client). */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/**
 * Error: surface the message verbatim. RcApiError messages already carry
 * actionable hints (401 → check PAT, 429 → wait ~60s), so we pass them through.
 */
export function fail(err: unknown): CallToolResult {
  const text = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Map a stored room type ('c'|'p'|'d') to the LLM-facing label. */
export function roomTypeLabel(t: string): 'channel' | 'group' | 'dm' {
  switch (t) {
    case 'p':
      return 'group';
    case 'd':
      return 'dm';
    default:
      return 'channel';
  }
}

/** Map an LLM-facing room type label back to the stored type code. */
export function roomTypeCode(
  type: 'channel' | 'group' | 'dm',
): 'c' | 'p' | 'd' {
  switch (type) {
    case 'group':
      return 'p';
    case 'dm':
      return 'd';
    default:
      return 'c';
  }
}

/** Coverage string for a room: 'full' once backfilled, else how far back we go. */
export function coverageOf(room: RoomRow): string {
  if (room.fully_backfilled === 1) return 'full';
  return room.oldest_loaded_ts != null
    ? `partial since ${room.oldest_loaded_ts}`
    : 'partial';
}

/** The standard read-tool envelope wrapping a room's messages. */
export interface ReadEnvelope {
  room: { id: string; name: string; type: 'channel' | 'group' | 'dm' };
  syncedThrough: string | null;
  coverage: string;
  messages: CompactMessage[];
}

/** Build the read envelope, attaching a permalink to each message. Pass the
 *  raw rows (not pre-compacted records) so the link can be composed from the
 *  room + base URL here, keeping every read surface consistent. */
export function readEnvelope(
  room: RoomRow,
  rows: MessageRow[],
  baseUrl: string,
): ReadEnvelope {
  return {
    room: {
      id: room.rid,
      name: room.name ?? room.fname ?? room.rid,
      type: roomTypeLabel(room.t),
    },
    syncedThrough: room.last_synced_at ?? null,
    coverage: coverageOf(room),
    messages: rows.map((r) => rowToCompactWithLink(r, room, baseUrl)),
  };
}
