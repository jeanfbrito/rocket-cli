// Hybrid full-text search: local FTS5 first, server-side chat.search fallback
// that enriches the cache. Pure query layer over Db + RcClient — no sync logic
// of its own (it depends on a minimal SyncLike to lazily freshen a room before
// searching it).
import type { Db } from './db.js';
import type { RcClient } from './rc-client.js';
import { RcApiError } from './errors.js';
import { log } from './log.js';
import { messageToRow, rowToCompact, rowToCompactWithLink, type RcWireMessage } from './normalize.js';
import type { CompactMessage, MessageRow, RoomRow } from './types.js';

/**
 * Minimal sync surface this service needs. The real implementation lives in
 * sync.ts (owned by another builder); declared here as DI so search.ts has no
 * hard dependency on it and stays unit-testable with a fake.
 */
export interface SyncLike {
  ensureRoomSynced(rid: string): Promise<void>;
}

/** A single search hit: the compact record plus retrieval metadata. */
export type SearchHit = CompactMessage & {
  snippet?: string;
  roomId: string;
  source: 'local' | 'server';
};

export interface SearchResult {
  results: SearchHit[];
  /** True when results came only from the local cache (no server fallback ran). */
  localOnly: boolean;
  /** Human-facing note when results are thin or the server fallback failed. */
  note?: string;
}

export interface SearchOptions {
  room?: RoomRow;
  author?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 20;
/** Below this many local hits (capped at the limit) we try the server. */
const THIN_THRESHOLD = 5;

const NOTE_NO_ROOM =
  'local cache only — pass a room for server-side search';

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression.
 *
 * FTS5 MATCH treats `"`, `*`, `(`, `)`, `-`, `:`, `^`, and the bareword
 * operators `AND`/`OR`/`NOT`/`NEAR` as syntax — raw user text containing them
 * throws a "fts5: syntax error". Strategy: split on whitespace, strip every
 * double quote from each token, then re-wrap each token in double quotes so it
 * is matched as a literal string term. Quoted terms joined by whitespace are
 * an implicit AND, and a quoted bareword like `"AND"` is a literal, not an
 * operator. A trailing `*` on a token is preserved as a prefix query
 * (`"foo"*`). Empty input (or input that sanitizes to nothing) throws.
 */
export function sanitizeFtsQuery(input: string): string {
  const tokens = input.split(/\s+/).filter((t) => t.length > 0);
  const out: string[] = [];
  for (const token of tokens) {
    // Preserve a single trailing '*' as a prefix marker before stripping it
    // out of the literal portion.
    const prefix = token.endsWith('*');
    const core = (prefix ? token.slice(0, -1) : token).replace(/"/g, '');
    if (core.length === 0) continue;
    out.push(prefix ? `"${core}"*` : `"${core}"`);
  }
  if (out.length === 0) throw new Error('empty search query');
  return out.join(' ');
}

interface FtsRow extends MessageRow {
  rank: number;
  snip: string;
}

export class SearchService {
  constructor(
    private readonly db: Db,
    private readonly rc: RcClient,
    private readonly sync: SyncLike,
    /** Server base URL for composing message permalinks. Optional so existing
     *  callers/tests keep their 3-arg signature; links are omitted when absent
     *  or when the hit's room isn't cached. */
    private readonly baseUrl?: string,
  ) {}

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const room = opts.room;

    if (room) {
      await this.sync.ensureRoomSynced(room.rid);
    }

    const local = this.searchLocal(query, opts, limit);
    const localHits: SearchHit[] = local.map((row) => this.toHit(row, 'local'));

    const thinThreshold = Math.min(limit, THIN_THRESHOLD);

    // No room → cannot run server-side search (chat.search is room-scoped).
    if (!room) {
      const result: SearchResult = { results: localHits, localOnly: true };
      if (localHits.length < thinThreshold) result.note = NOTE_NO_ROOM;
      return result;
    }

    // Enough local hits → done, no network.
    if (localHits.length >= thinThreshold) {
      return { results: localHits, localOnly: true };
    }

    // Thin local results + a room → enrich via server search.
    return this.searchServer(query, room, limit, localHits);
  }

  /** Local FTS5 query. Throws Error('invalid search query') on FTS syntax error. */
  private searchLocal(
    query: string,
    opts: SearchOptions,
    limit: number,
  ): FtsRow[] {
    const match = sanitizeFtsQuery(query);

    const clauses = ['messages_fts MATCH @match', 'm.deleted = 0'];
    const params: Record<string, unknown> = { match, limit };
    if (opts.room) {
      clauses.push('m.rid = @rid');
      params['rid'] = opts.room.rid;
    }
    if (opts.author !== undefined) {
      clauses.push('m.author_username = @author');
      params['author'] = opts.author;
    }

    const sql = `
      SELECT m.*, bm25(messages_fts) AS rank,
             snippet(messages_fts, 0, '«', '»', '…', 12) AS snip
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY rank
      LIMIT @limit`;

    try {
      return this.db.conn.prepare(sql).all(params) as FtsRow[];
    } catch (e) {
      // The sanitizer should make this unreachable, but FTS5 has edge cases —
      // never leak a raw "fts5: syntax error" to the caller.
      log.warn(`FTS query failed for ${JSON.stringify(match)}: ${String(e)}`);
      throw new Error('invalid search query');
    }
  }

  /**
   * Server-side fallback. Uses the ORIGINAL (unsanitized) query — chat.search
   * does its own parsing and benefits from operators we strip for FTS5. Results
   * are upserted into the cache (search enriches the local store) and merged
   * with the local hits, local first, de-duplicated by id.
   */
  private async searchServer(
    query: string,
    room: RoomRow,
    limit: number,
    localHits: SearchHit[],
  ): Promise<SearchResult> {
    try {
      const resp = await this.rc.searchMessages({
        roomId: room.rid,
        searchText: query,
        count: limit,
      });
      const serverMsgs: RcWireMessage[] = resp.messages ?? [];

      if (serverMsgs.length > 0) {
        const rows = serverMsgs.map((m) => messageToRow(m, room.rid));
        this.db.upsertMessages(rows);
      }

      const seen = new Set(localHits.map((h) => h.id));
      const merged: SearchHit[] = [...localHits];
      for (const m of serverMsgs) {
        const row = messageToRow(m, room.rid);
        if (!row.id || seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push(this.toHit(row, 'server'));
      }

      return { results: merged, localOnly: false };
    } catch (e) {
      // Server fallback must never sink the whole search — degrade to local.
      if (e instanceof RcApiError) {
        log.warn(`Server search fallback failed (${room.rid}): ${e.message}`);
        return {
          results: localHits,
          localOnly: true,
          note: 'server search unavailable — showing local cache only',
        };
      }
      throw e;
    }
  }

  private toHit(row: MessageRow, source: 'local' | 'server'): SearchHit {
    // Search spans all cached rooms, so look up each hit's room to build its
    // link. Tolerate an unknown room (or no baseUrl) by omitting the link.
    const room = this.baseUrl ? this.db.getRoom(row.rid) : undefined;
    const compact =
      this.baseUrl && room
        ? rowToCompactWithLink(row, room, this.baseUrl)
        : rowToCompact(row);
    const hit: SearchHit = { ...compact, roomId: row.rid, source };
    const snip = (row as Partial<FtsRow>).snip;
    if (typeof snip === 'string' && snip.length > 0) hit.snippet = snip;
    return hit;
  }
}
