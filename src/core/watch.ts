// Topic monitor: poll one or all rooms, force a sync each tick, then run a
// LOCAL-ONLY FTS query for new matches since a watermark. Deliberately never
// falls back to server-side search (that would burn the rate limit every
// tick); the per-room force-sync already pulls fresh messages into the cache,
// and we read them out of SQLite afterwards.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sendMessage, type App } from './app.js';
import { ConfigError } from './errors.js';
import { log } from './log.js';
import { rowToCompact } from './normalize.js';
import { sanitizeFtsQuery } from './search.js';
import type { CompactMessage, MessageRow, RoomRow } from './types.js';

/** Floor on the watch poll interval; tighter than this risks rate limiting. */
export const MIN_INTERVAL_SECONDS = 15;

/** A single watch hit: the compact record plus the human room name. */
export type WatchMatch = CompactMessage & { roomName: string };

export interface RunOnceOptions {
  query: string;
  /** Optional room reference (rid / #name / @user / substring). */
  room?: string;
  /** Only surface messages with ts strictly greater than this ISO timestamp. */
  sinceTs: string;
}

export interface RunOnceResult {
  matches: WatchMatch[];
  /** Advanced to the max ts seen, or unchanged when there were no matches. */
  nextSinceTs: string;
}

export interface WatchLoopOptions {
  query: string;
  room?: string;
  /** Poll interval in seconds; floored at MIN_INTERVAL_SECONDS. */
  intervalSeconds: number;
  /** If set, post each match to this target via app.sendMessage. */
  notifyTarget?: string;
  /** If set, append a JSON line per match to this file path. */
  logPath?: string;
  /** Optional abort signal; aborting ends the loop promptly (even mid-sleep). */
  signal?: AbortSignal;
  /** Watermark to start from; defaults to "now" (only NEW messages). */
  sinceTs?: string;
  /** Called synchronously for every match as it is discovered. */
  onMatch: (m: WatchMatch) => void;
}

interface WatchFtsRow extends MessageRow {
  rank: number;
}

/**
 * Sleep for `ms`, resolving early (without rejecting) if `signal` aborts.
 * Returns true if it slept the full duration, false if interrupted by abort.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class WatchService {
  constructor(private readonly app: App) {}

  /**
   * Force-sync the target room(s), then run a single LOCAL FTS query for
   * non-deleted messages newer than `sinceTs`, oldest first. Returns the
   * matches (each tagged with its room name) plus the next watermark.
   */
  async runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
    const { query, sinceTs } = opts;

    let rooms: RoomRow[];
    if (opts.room) {
      rooms = [await this.app.rooms.resolve(opts.room)];
    } else {
      rooms = await this.app.rooms.list();
    }

    // Force-sync each room sequentially. RcClient's global semaphore handles
    // pacing; doing it in series keeps the request burst bounded.
    for (const room of rooms) {
      await this.app.sync.ensureRoomSynced(room.rid, { force: true });
    }

    const rows = this.queryLocal(query, sinceTs, opts.room ? rooms[0]!.rid : undefined);

    // Map rid -> human name for labelling. rooms.list/resolve already populated
    // the cache, so a direct getRoom is enough for any rid we matched.
    const nameFor = (rid: string): string => {
      const r = this.app.db.getRoom(rid);
      return r?.name ?? r?.fname ?? rid;
    };

    const matches: WatchMatch[] = [];
    let maxTs = sinceTs;
    for (const row of rows) {
      const compact = rowToCompact(row);
      matches.push({ ...compact, roomName: nameFor(row.rid) });
      if (row.ts > maxTs) maxTs = row.ts;
    }

    return { matches, nextSinceTs: maxTs };
  }

  /**
   * Poll loop: runOnce -> deliver matches (onMatch, optional notify, optional
   * log) -> sleep -> repeat. The watermark advances across ticks so each match
   * is delivered exactly once. A failure in one tick is logged and the loop
   * continues; ConfigError and abort end the loop.
   */
  async watch(opts: WatchLoopOptions): Promise<void> {
    const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, opts.intervalSeconds);
    const intervalMs = intervalSeconds * 1000;
    let sinceTs = opts.sinceTs ?? new Date().toISOString();

    for (;;) {
      if (opts.signal?.aborted) return;

      try {
        const res = await this.runOnce({
          query: opts.query,
          room: opts.room,
          sinceTs,
        });
        sinceTs = res.nextSinceTs;

        for (const match of res.matches) {
          opts.onMatch(match);
          if (opts.notifyTarget) {
            await this.notify(opts.notifyTarget, opts.query, match);
          }
          if (opts.logPath) {
            this.appendLog(opts.logPath, opts.query, opts.room, match);
          }
        }
      } catch (err) {
        // A bad config can never resolve itself by retrying — abort the loop.
        if (err instanceof ConfigError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`watch tick failed: ${msg}`);
      }

      const sleptFull = await abortableSleep(intervalMs, opts.signal);
      if (!sleptFull) return; // aborted mid-sleep
    }
  }

  // ---- internals ----------------------------------------------------------

  /** Local FTS query, filtered to ts > sinceTs (and optionally a single rid),
   *  ordered oldest first. Mirrors search.ts's SELECT minus the server path. */
  private queryLocal(
    query: string,
    sinceTs: string,
    rid: string | undefined,
  ): WatchFtsRow[] {
    const match = sanitizeFtsQuery(query);
    const clauses = [
      'messages_fts MATCH @match',
      'm.deleted = 0',
      'm.ts > @sinceTs',
    ];
    const params: Record<string, unknown> = { match, sinceTs };
    if (rid !== undefined) {
      clauses.push('m.rid = @rid');
      params['rid'] = rid;
    }

    const sql = `
      SELECT m.*, bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.rowid = messages_fts.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.ts ASC`;

    try {
      return this.app.db.conn.prepare(sql).all(params) as WatchFtsRow[];
    } catch (e) {
      log.warn(`watch FTS query failed for ${JSON.stringify(match)}: ${String(e)}`);
      throw new Error('invalid search query');
    }
  }

  private async notify(
    target: string,
    query: string,
    match: WatchMatch,
  ): Promise<void> {
    const text =
      `[watch:${query}] @${match.author} in ${match.roomName}: ` +
      `${match.text.slice(0, 200)}`;
    await sendMessage(this.app, { target, text });
  }

  private appendLog(
    logPath: string,
    query: string,
    room: string | undefined,
    match: WatchMatch,
  ): void {
    const dir = dirname(logPath);
    mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'match',
        query,
        room: room ?? null,
        author: match.author,
        msgId: match.id,
        text: match.text,
      }) + '\n';
    appendFileSync(logPath, line);
  }
}
