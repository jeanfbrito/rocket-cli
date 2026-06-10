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
import { messageToRow } from './normalize.js';
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
/** Hard cap on shallow-sync pagination. A never-synced unread room is triaged
 *  with at most this many history pages from the last-read watermark forward —
 *  bursts larger than 3*PAGE_SIZE messages are intentionally truncated (a
 *  timeline read will lazily deepen via extendBackfill if the room is opened).
 *  Honesty over completeness for the "what's unread" view. */
const MAX_SHALLOW_PAGES = 3;
/** A foreground read on a totally-cold room blocks for this many history pages
 *  (enough to answer "show me recent messages") and then background-completes
 *  THAT room's remaining backfill. One page = 100 messages. */
const COLD_FIRST_PAGES = 1;

/**
 * Outcome of a sync request. `refreshing` is true when a background (un-awaited)
 * sync was kicked and fresher data will land shortly — read paths thread this
 * into their envelope/report so the client knows the answer may be seconds
 * stale. False means the served data is already current (fresh cache or a
 * blocking sync that just completed).
 */
export interface SyncOutcome {
  refreshing: boolean;
}

/** Narrow a room type to the three values getHistory accepts; anything else
 *  (e.g. a malformed payload) defaults to channels.history, matching the prior
 *  historyEndpoint() fallback. */
function historyRoomType(t: string): 'c' | 'p' | 'd' {
  return t === 'p' || t === 'd' ? t : 'c';
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
   * Ensure the room's cache is up to date and return whether a background
   * refresh is in progress.
   *
   * Default (`blocking: true`) preserves the original contract: backfill if
   * never synced, delta if stale, no-op if fresh — all awaited. The returned
   * outcome is always `{ refreshing: false }` because the caller waited.
   *
   * Stale-while-revalidate (`blocking: false`) — for READ paths that want the
   * cache to accelerate, never block:
   *   - Room has cached data and is merely TTL-stale → serve immediately and
   *     kick the delta un-awaited (deduped via the per-room mutex; errors to
   *     log.debug). Returns `{ refreshing: true }`.
   *   - Room is totally cold (never synced / no local data) → we cannot serve
   *     nothing, so block on the FIRST backfill page only (COLD_FIRST_PAGES),
   *     then kick the remainder of the backfill in the background. Returns
   *     `{ refreshing: true }`.
   *   - Room is fresh → no-op, `{ refreshing: false }`.
   *
   * `force` still forces a (blocking) re-sync regardless of TTL.
   */
  ensureRoomSynced(
    rid: string,
    opts?: { force?: boolean; blocking?: boolean },
  ): Promise<SyncOutcome> {
    const blocking = opts?.blocking ?? true;
    if (blocking) {
      return this.withRoomLock(rid, () =>
        this.doEnsureRoomSynced(rid, opts),
      ).then(() => ({ refreshing: false }));
    }
    return this.doEnsureRoomSyncedSWR(rid, opts);
  }

  /**
   * Non-blocking variant. Resolves the room (may refresh the directory once),
   * then decides synchronously from the cached row whether to block (cold) or
   * serve-and-kick (warm-stale). Read paths should prefer this.
   */
  async ensureRoomSyncedSWR(
    rid: string,
    opts?: { force?: boolean },
  ): Promise<SyncOutcome> {
    return this.doEnsureRoomSyncedSWR(rid, opts);
  }

  private async doEnsureRoomSyncedSWR(
    rid: string,
    opts?: { force?: boolean },
  ): Promise<SyncOutcome> {
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

    const hasLocalData =
      room.last_synced_at != null || room.oldest_loaded_ts != null;

    // Totally cold: we have nothing to serve. Block on the first backfill page
    // only (enough to answer the read), then complete the depth in background.
    if (!hasLocalData) {
      const r = room;
      await this.withRoomLock(rid, () =>
        this.backfill(r, { maxPages: COLD_FIRST_PAGES }),
      );
      // If the first page did not exhaust the room, deepen the rest in the
      // background so a later "show older" read is already covered.
      const after = this.db.getRoom(rid);
      const refreshing = after?.fully_backfilled !== 1;
      if (refreshing) this.kickBackgroundBackfill(rid);
      return { refreshing };
    }

    // Warm: decide staleness without touching the network.
    const stale =
      opts?.force === true ||
      room.last_synced_at == null ||
      Date.now() - Date.parse(room.last_synced_at) > this.ttlMs;
    if (!stale) return { refreshing: false };

    // Stale but cached → serve now, revalidate in background.
    this.kickBackgroundSync(rid, opts);
    return { refreshing: true };
  }

  /**
   * Fire-and-forget a foreground-equivalent sync for a room. Deduped by the
   * per-room mutex: if a sync is already in flight, withRoomLock returns that
   * promise and we do NOT stack a second one. Errors are swallowed to
   * log.debug — a background refresh failing must never surface to the caller
   * (the served stale data is still valid). Idempotent and abort-safe: on
   * process exit the in-flight upserts simply stop.
   */
  private kickBackgroundSync(rid: string, opts?: { force?: boolean }): void {
    void this.withRoomLock(rid, () => this.doEnsureRoomSynced(rid, opts)).catch(
      (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.debug(`Background sync for room ${rid} failed: ${msg}`);
      },
    );
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

    await this.syncedRoomDelta(room, opts);
  }

  /**
   * Reconcile an already-synced room (last_synced_at set): no-op if fresh,
   * bounded re-backfill if the watermark predates the backfill window, delta
   * otherwise. Extracted so ensureRoomSyncedShallow can reuse it WITHOUT
   * re-entering ensureRoomSynced (which would coalesce onto the in-flight
   * shallow promise it is already running under and return a no-op).
   */
  private async syncedRoomDelta(
    room: RoomRow,
    opts?: { force?: boolean },
  ): Promise<void> {
    const stale =
      opts?.force === true ||
      Date.now() - Date.parse(room.last_synced_at!) > this.ttlMs;
    if (stale) {
      // Stale-delta guard: chat.syncMessages on the lastUpdate path uses
      // handleWithoutPagination — it returns EVERY update since the watermark
      // in a single unbounded response (ignores count, no cursor). A room that
      // has been stale for longer than the backfill window would force one
      // giant Mongo query and payload (worse on admin/bot tokens, which bypass
      // the rate limiter). A fresh bounded backfill from now is both lighter on
      // the server and more useful than that unbounded delta, so treat such a
      // room as first-touch and re-backfill instead.
      const backfillCutoffMs =
        Date.now() - this.backfillDays * 24 * 60 * 60 * 1000;
      if (Date.parse(room.last_synced_at!) < backfillCutoffMs) {
        log.debug(
          `Room ${room.rid} last synced ${room.last_synced_at} predates the ` +
            `${this.backfillDays}-day backfill window; resetting to a bounded ` +
            'backfill instead of an unbounded syncMessages delta.',
        );
        await this.backfill(room);
        return;
      }
      await this.delta(room);
    }
    // else: fresh — zero network.
  }

  // ---- shallow sync -------------------------------------------------------

  /**
   * Triage-oriented sync for the "what's unread" view. Cheap by construction:
   * a never-synced unread room's actual unread payload is just the messages
   * after the last-read watermark (`sinceTs`) — usually a handful — so we fetch
   * only that window instead of running the full backfill (500 msgs / 5 pages).
   *
   *  - Already synced (last_synced_at set): delegate to ensureRoomSynced. The
   *    delta path is already a single cheap syncMessages call.
   *  - Never synced: ONE forward history window from `sinceTs` (paged at most
   *    MAX_SHALLOW_PAGES for an unread burst), then record a "shallowly known"
   *    sync state — last_synced_at watermarked before the fetch (future deltas
   *    work normally), oldest_loaded_ts = sinceTs, fully_backfilled = 0. A later
   *    timeline read going older than sinceTs triggers extendBackfill naturally,
   *    giving lazy full history exactly when someone actually reads the room.
   *
   * Shares the per-room mutex with ensureRoomSynced, so a concurrent shallow +
   * full call coalesce onto whichever is already in flight.
   */
  ensureRoomSyncedShallow(rid: string, sinceTs: string): Promise<SyncOutcome> {
    return this.doEnsureRoomSyncedShallow(rid, sinceTs);
  }

  private async doEnsureRoomSyncedShallow(
    rid: string,
    sinceTs: string,
  ): Promise<SyncOutcome> {
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

    // Already known: serve from cache, revalidate the delta in the background.
    // The delta is cheap, but a triage view must never block on it — the unread
    // slice is already in the local cache (it was synced before).
    if (room.last_synced_at != null) {
      const stale = Date.now() - Date.parse(room.last_synced_at) > this.ttlMs;
      if (!stale) return { refreshing: false };
      this.kickBackgroundSync(rid);
      return { refreshing: true };
    }

    // Never synced: bounded forward window from the last-read watermark. This
    // blocks — the slice IS the answer the triage view needs to return.
    const cold = room;
    return this.withRoomLock(rid, () =>
      this.shallowBackfill(cold, sinceTs),
    ).then(() => ({ refreshing: false }));
  }

  private async shallowBackfill(room: RoomRow, sinceTs: string): Promise<void> {
    const syncStart = new Date().toISOString();
    const roomType = historyRoomType(room.t);
    let latest: string | undefined; // first page: from now backwards to sinceTs

    for (let page = 0; page < MAX_SHALLOW_PAGES; page++) {
      const res = await this.rc.getHistory(roomType, {
        roomId: room.rid,
        oldest: sinceTs,
        count: PAGE_SIZE,
        showThreadMessages: true,
        ...(latest !== undefined && { latest }),
      });
      const messages = res.messages ?? [];
      if (messages.length > 0) {
        this.db.upsertMessages(messages.map((m) => messageToRow(m, room.rid)));
      }

      // Short page → the whole [sinceTs, now] window is loaded.
      if (messages.length < PAGE_SIZE) break;

      // Full page → there may be more unread within the window. Page backwards
      // from the oldest ts seen (bounded by sinceTs via the `oldest` param).
      let minMs = Number.POSITIVE_INFINITY;
      for (const m of messages) {
        const iso = messageToRow(m, room.rid).ts;
        const ms = Date.parse(iso);
        if (!Number.isNaN(ms) && ms < minMs) minMs = ms;
      }
      if (!Number.isFinite(minMs)) break;
      latest = new Date(minMs - 1).toISOString();

      if (page === MAX_SHALLOW_PAGES - 1) {
        log.debug(
          `Shallow sync for room ${room.rid} hit the ${MAX_SHALLOW_PAGES}-page ` +
            'cap; the unread burst exceeds ~300 messages and is truncated for ' +
            'triage. A timeline read will deepen it via extendBackfill.',
        );
      }
    }

    this.db.setRoomSyncState(room.rid, {
      lastSyncedAt: syncStart,
      oldestLoadedTs: sinceTs,
      fullyBackfilled: false,
    });
  }

  // ---- backfill -----------------------------------------------------------

  private async backfill(
    room: RoomRow,
    opts?: { maxPages?: number },
  ): Promise<void> {
    // Watermark BEFORE the first fetch: anything that arrives mid-sync gets
    // re-fetched on the next delta. Upserts are idempotent, so duplicates are
    // harmless.
    const syncStart = new Date().toISOString();
    const roomType = historyRoomType(room.t);
    const cutoffMs = Date.now() - this.backfillDays * 24 * 60 * 60 * 1000;
    // Page budget: undefined = run to completion (backfillLimit / exhaustion).
    // A finite cap (cold first-page read) stops early WITHOUT marking the room
    // fully_backfilled, so a later background pass / warmer finishes the depth.
    const maxPages = opts?.maxPages;

    let latest: string | undefined; // first call: now (omit param)
    let total = 0;
    let pages = 0;
    let oldestSeen: string | null = null;
    let fullyBackfilled = false;

    for (;;) {
      const res = await this.rc.getHistory(roomType, {
        roomId: room.rid,
        count: PAGE_SIZE,
        showThreadMessages: true,
        ...(latest !== undefined && { latest }),
      });
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
      // Hit the per-call page cap (cold first-page read). Leaves
      // fully_backfilled = false so a background pass finishes the depth.
      pages++;
      if (maxPages !== undefined && pages >= maxPages) break;
    }

    this.db.setRoomSyncState(room.rid, {
      lastSyncedAt: syncStart,
      oldestLoadedTs: oldestSeen,
      fullyBackfilled,
    });
  }

  /**
   * Background depth-completion for a room that a cold read populated with only
   * its first page. Deepens via extendBackfill to the full backfill window (the
   * same depth a blocking backfill would reach), fire-and-forget, deduped by
   * the per-room mutex, errors to log.debug. Abort-safe (idempotent upserts).
   */
  private kickBackgroundBackfill(rid: string): void {
    const room = this.db.getRoom(rid);
    if (!room || room.oldest_loaded_ts == null) return;
    const target = new Date(
      Date.now() - this.backfillDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    void this.extendBackfill(rid, target).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.debug(`Background backfill for room ${rid} failed: ${msg}`);
    });
  }

  // ---- delta --------------------------------------------------------------

  private async delta(room: RoomRow): Promise<void> {
    const syncStart = new Date().toISOString();
    const lastUpdate = room.last_synced_at!;

    try {
      let cursor: string | null = null;
      for (let page = 0; page < MAX_DELTA_PAGES; page++) {
        const res = await this.rc.syncMessages({
          roomId: room.rid,
          lastUpdate,
          count: PAGE_SIZE,
          ...(cursor ? { next: cursor } : {}),
        });
        const result = res.result;
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
    const roomType = historyRoomType(room.t);
    let latest: string | undefined;
    for (let page = 0; page < MAX_DELTA_PAGES; page++) {
      const res = await this.rc.getHistory(roomType, {
        roomId: room.rid,
        oldest,
        count: PAGE_SIZE,
        showThreadMessages: true,
        ...(latest !== undefined && { latest }),
      });
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
      const res = await this.rc.getMessage({ msgId: tmid });
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
        const res = await this.rc.getThreadMessages({
          tmid,
          count: PAGE_SIZE,
          offset,
        });
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

    const roomType = historyRoomType(room.t);
    const targetMs = Date.parse(beforeTs);
    let latest: string = oldest != null ? oldest : new Date().toISOString();
    let added = 0;
    let oldestSeen: string | null = oldest ?? null;
    let fullyBackfilled = false;

    for (;;) {
      const res = await this.rc.getHistory(roomType, {
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

  // ---- intent-driven depth ------------------------------------------------

  /**
   * Deepen ONE room's cached history on demand. Intent-driven — the opposite of
   * an ambient warmer: depth is loaded only when a caller explicitly asks (CLI
   * `sync`, or the `sync_history` MCP tool an agent calls when its task needs
   * history beyond the recent window). Never auto-invoked.
   *
   * `depth` caps how many additional older messages to pull this call (default
   * backfillLimit). A never-synced room runs a fresh backfill; a shallow/partial
   * room deepens backwards via extendBackfill toward the backfill-day window.
   * Coalesced by the per-room mutex (shares with any in-flight foreground sync).
   *
   * Returns the post-deepen state: how many net-new non-deleted messages landed,
   * whether the room is now fully backfilled, and the backfill horizon.
   */
  async deepenRoom(
    rid: string,
    depth?: number,
  ): Promise<{
    rid: string;
    messagesLoaded: number;
    fullyBackfilled: boolean;
    oldestLoadedTs: string | null;
  }> {
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

    const before = this.countRoomMessages(rid);
    const cold = room.last_synced_at == null && room.oldest_loaded_ts == null;

    if (room.fully_backfilled !== 1) {
      if (cold) {
        // Never touched: a fresh backfill (bounded by depth or backfillLimit).
        const r = room;
        const maxPages =
          depth !== undefined ? Math.max(1, Math.ceil(depth / PAGE_SIZE)) : undefined;
        await this.withRoomLock(rid, () => this.backfill(r, { maxPages }));
      } else {
        // Shallow/partial: page backwards toward the backfill-day window. The
        // depth cap is enforced by backfillLimit inside extendBackfill; we bound
        // the target at the configured window.
        const target = new Date(
          Date.now() - this.backfillDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        await this.extendBackfill(rid, target);
      }
    }

    const after = this.db.getRoom(rid) ?? room;
    return {
      rid,
      messagesLoaded: Math.max(0, this.countRoomMessages(rid) - before),
      fullyBackfilled: after.fully_backfilled === 1,
      oldestLoadedTs: after.oldest_loaded_ts ?? null,
    };
  }

  /**
   * Pick the most-stale unread room to deepen when `sync_history` is called with
   * no room argument: among rooms with current unread/alert activity that are
   * not yet fully backfilled, the one synced longest ago (nulls — never synced —
   * first). Returns null when nothing qualifies. Read-only.
   */
  pickStaleUnreadRoom(): string | null {
    const candidates = this.db
      .findUnreadRooms()
      .filter((r) => r.fully_backfilled !== 1);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const av = a.last_synced_at == null ? 0 : Date.parse(a.last_synced_at);
      const bv = b.last_synced_at == null ? 0 : Date.parse(b.last_synced_at);
      return av - bv; // oldest / never-synced first
    });
    return candidates[0]!.rid;
  }

  private countRoomMessages(rid: string): number {
    const row = this.db.conn
      .prepare(
        'SELECT COUNT(*) AS n FROM messages WHERE rid = ? AND deleted = 0',
      )
      .get(rid) as { n: number };
    return row.n;
  }

  // ---- thread parent seeding ---------------------------------------------

  /** Seed thread parents for a room if the local set is empty. Used by the
   *  list_threads tool so it has something to show before a full backfill. */
  async seedThreadParents(rid: string): Promise<void> {
    if (this.db.getThreadParents(rid, { limit: 1 }).length > 0) return;
    const res = await this.rc.getThreadsList({ rid, count: 50 });
    const threads = res.threads ?? [];
    if (threads.length > 0) {
      this.db.upsertMessages(threads.map((m) => messageToRow(m, rid)));
    }
  }
}
