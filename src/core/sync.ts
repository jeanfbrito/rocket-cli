// The sync engine — heart of the design. Every read path calls
// ensureRoomSynced(rid) (or ensureThreadLoaded(tmid)) and then reads SQLite
// only. This module owns all the network <-> cache reconciliation:
//   - initial backfill (history endpoints, paged backwards)
//   - delta sync (chat.syncMessages: edits + deletions, cursor-paged)
//   - thread completeness self-healing (tcount vs local reply count)
//   - older-history extension on demand
//   - a per-room in-process mutex so concurrent reads coalesce into one fetch
import type { Db } from './db.js';
import type { MessageRow, RoomRow } from './types.js';
import type { RcClient } from './rc-client.js';
import { messageToRow, type RcMessage } from './normalize.js';
import { RcApiError } from './errors.js';
import { log } from './log.js';

export interface SyncOptions {
  ttlSeconds: number;
  backfillLimit: number;
  /** Backfill no further back than this many days. Default 30. */
  backfillDays?: number;
}

const PAGE_SIZE = 100;
/** Hard cap on delta pagination loops, guarding against a server that keeps
 *  returning a non-null cursor forever. */
const MAX_DELTA_PAGES = 50;

interface HistoryResponse {
  messages?: RcMessage[];
}

interface SyncMessagesResponse {
  result?: {
    updated?: RcMessage[];
    deleted?: Array<{ _id?: string }>;
    cursor?: { next?: string | null; previous?: string | null };
  };
}

interface GetMessageResponse {
  message?: RcMessage;
}

interface ThreadMessagesResponse {
  messages?: RcMessage[];
  total?: number;
}

interface ThreadsListResponse {
  threads?: RcMessage[];
}

/** Map a room type to its history endpoint. */
function historyEndpoint(t: string): string {
  switch (t) {
    case 'c':
      return '/v1/channels.history';
    case 'p':
      return '/v1/groups.history';
    case 'd':
      return '/v1/im.history';
    default:
      // Default to channels.history; the server will reject if truly invalid.
      return '/v1/channels.history';
  }
}

export class SyncEngine {
  private readonly ttlMs: number;
  private readonly backfillLimit: number;
  private readonly backfillDays: number;

  /** Per-room in-flight promise. Concurrent ensureRoomSynced(rid) calls share
   *  the same promise; different rids proceed independently (network
   *  concurrency is bounded separately by RcClient's global semaphore). */
  private readonly inflight = new Map<string, Promise<void>>();

  /** Whether we have already logged the syncMessages->history degrade warning
   *  (logged once per process to avoid noise on every delta). */
  private degradeWarned = false;

  constructor(
    private readonly db: Db,
    private readonly rc: RcClient,
    private readonly rooms: { refresh(): Promise<void> },
    opts: SyncOptions,
  ) {
    this.ttlMs = opts.ttlSeconds * 1000;
    this.backfillLimit = opts.backfillLimit;
    this.backfillDays = opts.backfillDays ?? 30;
  }

  /** Coalesce work for a single room id behind one in-flight promise. */
  private withRoomLock(rid: string, fn: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(rid);
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.inflight.delete(rid);
    });
    this.inflight.set(rid, promise);
    return promise;
  }

  /**
   * Ensure the room's cache is up to date: backfill if never synced, delta if
   * stale, no-op if fresh. Coalesced per room.
   */
  ensureRoomSynced(rid: string, opts?: { force?: boolean }): Promise<void> {
    return this.withRoomLock(rid, () => this.doEnsureRoomSynced(rid, opts));
  }

  private async doEnsureRoomSynced(
    rid: string,
    opts?: { force?: boolean },
  ): Promise<void> {
    let room = this.db.getRoom(rid);
    if (!room) {
      await this.rooms.refresh();
      room = this.db.getRoom(rid);
      if (!room) {
        throw new Error(
          `Room "${rid}" not found after refreshing subscriptions — ` +
            'you may not be a member, or the id is invalid.',
        );
      }
    }

    if (room.last_synced_at == null) {
      await this.backfill(room);
      return;
    }

    const stale =
      opts?.force === true ||
      Date.now() - Date.parse(room.last_synced_at) > this.ttlMs;
    if (stale) {
      await this.delta(room);
    }
    // else: fresh — zero network.
  }

  // ---- backfill -----------------------------------------------------------

  private async backfill(room: RoomRow): Promise<void> {
    // Watermark BEFORE the first fetch: anything that arrives mid-sync gets
    // re-fetched on the next delta. Upserts are idempotent, so duplicates are
    // harmless.
    const syncStart = new Date().toISOString();
    const endpoint = historyEndpoint(room.t);
    const cutoffMs = Date.now() - this.backfillDays * 24 * 60 * 60 * 1000;

    let latest: string | undefined; // first call: now (omit param)
    let total = 0;
    let oldestSeen: string | null = null;
    let fullyBackfilled = false;

    for (;;) {
      const params: Record<string, unknown> = {
        roomId: room.rid,
        count: PAGE_SIZE,
        showThreadMessages: true,
      };
      if (latest !== undefined) params['latest'] = latest;

      const res = await this.rc.get<HistoryResponse>(endpoint, params);
      const messages = res.messages ?? [];
      if (messages.length > 0) {
        const rows = messages.map((m) => messageToRow(m, room.rid));
        this.db.upsertMessages(rows);
        total += rows.length;

        // Track the oldest ts seen and compute the next cursor from it.
        let minIso: string | null = null;
        let minMs = Number.POSITIVE_INFINITY;
        for (const r of rows) {
          if (r.ts === '') continue;
          const ms = Date.parse(r.ts);
          if (Number.isNaN(ms)) continue;
          if (ms < minMs) {
            minMs = ms;
            minIso = r.ts;
          }
        }
        if (minIso !== null) {
          if (oldestSeen === null || Date.parse(minIso) < Date.parse(oldestSeen)) {
            oldestSeen = minIso;
          }
          // Next page strictly older than the oldest we have.
          latest = new Date(minMs - 1).toISOString();
        }

        // Stop if the oldest message we just loaded predates the backfill
        // window.
        if (Number.isFinite(minMs) && minMs < cutoffMs) break;
      }

      // Exhausted the room: short page means there is nothing older.
      if (messages.length < PAGE_SIZE) {
        fullyBackfilled = true;
        break;
      }
      // Hit the configured depth limit.
      if (total >= this.backfillLimit) break;
    }

    this.db.setRoomSyncState(room.rid, {
      lastSyncedAt: syncStart,
      oldestLoadedTs: oldestSeen,
      fullyBackfilled,
    });
  }

  // ---- delta --------------------------------------------------------------

  private async delta(room: RoomRow): Promise<void> {
    const syncStart = new Date().toISOString();
    const lastUpdate = room.last_synced_at!;

    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_DELTA_PAGES; page++) {
        const params: Record<string, unknown> = {
          roomId: room.rid,
          lastUpdate,
          count: PAGE_SIZE,
        };
        if (cursor) params['next'] = cursor;

        const res = await this.rc.get<SyncMessagesResponse>(
          '/v1/chat.syncMessages',
          params,
        );
        const result = res.result ?? {};
        const updated = result.updated ?? [];
        const deleted = result.deleted ?? [];

        if (updated.length > 0) {
          this.db.upsertMessages(updated.map((m) => messageToRow(m, room.rid)));
        }
        const deletedIds = deleted
          .map((d) => d._id)
          .filter((id): id is string => typeof id === 'string' && id !== '');
        if (deletedIds.length > 0) this.db.markMessagesDeleted(deletedIds);

        const next = result.cursor?.next ?? null;
        // Continue only when the server signals more AND this page was full.
        if (!next || updated.length !== PAGE_SIZE) break;
        cursor = next;

        if (page === MAX_DELTA_PAGES - 1) {
          log.warn(
            `Delta sync for room ${room.rid} hit the ${MAX_DELTA_PAGES}-page ` +
              'cap; will continue on the next sync.',
          );
        }
      }
    } catch (err) {
      // Older servers (or instances with the endpoint disabled) reject
      // syncMessages with 400. Degrade to a history catch-up from the last
      // watermark — no deletion detection, but new/edited messages are caught.
      if (err instanceof RcApiError && err.status === 400) {
        if (!this.degradeWarned) {
          log.warn(
            'chat.syncMessages unavailable (HTTP 400); degrading to ' +
              'history-based delta (deletions will not be detected).',
          );
          this.degradeWarned = true;
        }
        await this.historyCatchUp(room, lastUpdate);
      } else {
        throw err;
      }
    }

    this.db.setRoomSyncState(room.rid, { lastSyncedAt: syncStart });
  }

  /** Fallback delta: page history forward from the last watermark. No deletion
   *  detection — history endpoints never report removals. */
  private async historyCatchUp(room: RoomRow, oldest: string): Promise<void> {
    const endpoint = historyEndpoint(room.t);
    let latest: string | undefined;
    for (let page = 0; page < MAX_DELTA_PAGES; page++) {
      const params: Record<string, unknown> = {
        roomId: room.rid,
        oldest,
        count: PAGE_SIZE,
        showThreadMessages: true,
      };
      if (latest !== undefined) params['latest'] = latest;

      const res = await this.rc.get<HistoryResponse>(endpoint, params);
      const messages = res.messages ?? [];
      if (messages.length > 0) {
        this.db.upsertMessages(messages.map((m) => messageToRow(m, room.rid)));
      }
      if (messages.length < PAGE_SIZE) break;

      // Page backwards through the [oldest, latest) window until exhausted.
      let minMs = Number.POSITIVE_INFINITY;
      for (const m of messages) {
        const iso = messageToRow(m, room.rid).ts;
        const ms = Date.parse(iso);
        if (!Number.isNaN(ms) && ms < minMs) minMs = ms;
      }
      if (!Number.isFinite(minMs)) break;
      latest = new Date(minMs - 1).toISOString();
    }
  }

  // ---- threads ------------------------------------------------------------

  /**
   * Ensure a thread's replies are fully loaded, returning the parent message.
   * Freshness comes from the room delta (replies are room messages); this only
   * fills backfill gaps when tcount > local reply count or no sync row exists.
   */
  async ensureThreadLoaded(tmid: string): Promise<MessageRow> {
    let parent = this.db.getMessage(tmid);
    if (!parent) {
      // Parent unknown locally — fetch it directly so we can learn its room.
      const res = await this.rc.get<GetMessageResponse>('/v1/chat.getMessage', {
        msgId: tmid,
      });
      if (!res.message || !res.message._id) {
        throw new Error(`Thread parent "${tmid}" not found.`);
      }
      const rid = res.message.rid ?? '';
      const row = messageToRow(res.message, rid);
      this.db.upsertMessages([row]);
      parent = row;
    }

    // Bring the room up to date; delta may bump the parent's tcount/tlm.
    await this.ensureRoomSynced(parent.rid);
    parent = this.db.getMessage(tmid) ?? parent;

    const expected = parent.tcount ?? 0;
    const localCount = this.db.countThreadReplies(tmid);
    const syncRow = this.db.getThreadSync(tmid);
    const needsFetch = expected > localCount || syncRow == null;

    if (needsFetch) {
      let offset = 0;
      let total = Number.POSITIVE_INFINITY;
      for (let page = 0; page < MAX_DELTA_PAGES; page++) {
        const res = await this.rc.get<ThreadMessagesResponse>(
          '/v1/chat.getThreadMessages',
          { tmid, count: PAGE_SIZE, offset },
        );
        const messages = res.messages ?? [];
        if (typeof res.total === 'number') total = res.total;
        if (messages.length > 0) {
          this.db.upsertMessages(
            messages.map((m) => messageToRow(m, parent!.rid)),
          );
          offset += messages.length;
        }
        if (messages.length < PAGE_SIZE || offset >= total) break;
      }
      this.db.setThreadSync(tmid, {
        lastSyncedAt: new Date().toISOString(),
        fullyLoaded: true,
      });
    }

    return parent;
  }

  // ---- older-history extension -------------------------------------------

  /**
   * Extend backfill backwards so the cache covers messages at/after `beforeTs`.
   * No-op when the room is fully backfilled or the requested point is already
   * within the loaded window.
   */
  extendBackfill(rid: string, beforeTs: string): Promise<void> {
    return this.withRoomLock(rid, () => this.doExtendBackfill(rid, beforeTs));
  }

  private async doExtendBackfill(rid: string, beforeTs: string): Promise<void> {
    const room = this.db.getRoom(rid);
    if (!room) return;
    if (room.fully_backfilled === 1) return;

    const oldest = room.oldest_loaded_ts;
    // Already covered: the requested point is no older than what we have.
    if (oldest != null && beforeTs >= oldest) return;

    const endpoint = historyEndpoint(room.t);
    const targetMs = Date.parse(beforeTs);
    let latest: string | undefined =
      oldest != null ? oldest : new Date().toISOString();
    let added = 0;
    let oldestSeen: string | null = oldest ?? null;
    let fullyBackfilled = false;

    for (;;) {
      const res = await this.rc.get<HistoryResponse>(endpoint, {
        roomId: rid,
        count: PAGE_SIZE,
        latest,
        showThreadMessages: true,
      });
      const messages = res.messages ?? [];
      if (messages.length > 0) {
        const rows = messages.map((m) => messageToRow(m, rid));
        this.db.upsertMessages(rows);
        added += rows.length;

        let minMs = Number.POSITIVE_INFINITY;
        let minIso: string | null = null;
        for (const r of rows) {
          if (r.ts === '') continue;
          const ms = Date.parse(r.ts);
          if (Number.isNaN(ms)) continue;
          if (ms < minMs) {
            minMs = ms;
            minIso = r.ts;
          }
        }
        if (minIso !== null) {
          if (
            oldestSeen === null ||
            Date.parse(minIso) < Date.parse(oldestSeen)
          ) {
            oldestSeen = minIso;
          }
          latest = new Date(minMs - 1).toISOString();
        }

        // Covered the requested point.
        if (
          !Number.isNaN(targetMs) &&
          Number.isFinite(minMs) &&
          minMs <= targetMs
        ) {
          break;
        }
      }

      if (messages.length < PAGE_SIZE) {
        fullyBackfilled = true;
        break;
      }
      if (added >= this.backfillLimit) break;
    }

    this.db.setRoomSyncState(rid, {
      oldestLoadedTs: oldestSeen,
      fullyBackfilled,
    });
  }

  // ---- thread parent seeding ---------------------------------------------

  /** Seed thread parents for a room if the local set is empty. Used by the
   *  list_threads tool so it has something to show before a full backfill. */
  async seedThreadParents(rid: string): Promise<void> {
    if (this.db.getThreadParents(rid, { limit: 1 }).length > 0) return;
    const res = await this.rc.get<ThreadsListResponse>(
      '/v1/chat.getThreadsList',
      { rid, count: 50 },
    );
    const threads = res.threads ?? [];
    if (threads.length > 0) {
      this.db.upsertMessages(threads.map((m) => messageToRow(m, rid)));
    }
  }
}
