// Room directory: subscriptions sync (TTL + refresh-on-miss) plus resolution of
// human-friendly room references (rid / #name / @user / fname / substring) into
// a concrete RoomRow. The sync engine and CLI/MCP layers depend on this to turn
// whatever the caller typed into a room id before reading the cache.
import type { Db } from './db.js';
import type { RoomRow } from './types.js';
import type { RcClient } from './rc-client.js';
import { subscriptionToRoomRow, type RcSubscription } from './normalize.js';

/** Meta key holding the ISO timestamp of the last subscriptions refresh. */
const ROOMS_REFRESHED_AT = 'rooms_refreshed_at';
/** Subscriptions are considered fresh for 5 minutes. */
const ROOMS_TTL_MS = 5 * 60 * 1000;

interface SubscriptionsGetResponse {
  update?: RcSubscription[];
  remove?: unknown[];
}

export class RoomDirectory {
  constructor(
    private readonly db: Db,
    private readonly rc: RcClient,
  ) {}

  /** Pull the full subscription list and upsert every room. */
  async refresh(): Promise<void> {
    const res = await this.rc.get<SubscriptionsGetResponse>(
      '/v1/subscriptions.get',
    );
    const subs = res.update ?? [];
    const rows = subs.map(subscriptionToRoomRow);
    if (rows.length > 0) this.db.upsertRooms(rows);
    this.db.setMeta(ROOMS_REFRESHED_AT, new Date().toISOString());
  }

  /** Refresh only if the subscription cache is older than the TTL. */
  async ensureFresh(): Promise<void> {
    const last = this.db.getMeta(ROOMS_REFRESHED_AT);
    if (last) {
      const age = Date.now() - Date.parse(last);
      if (Number.isFinite(age) && age < ROOMS_TTL_MS) return;
    }
    await this.refresh();
  }

  /**
   * Resolve a human reference into a concrete room. Matching order:
   *   1. exact rid
   *   2. '@username' → DM room (t='d') whose name/fname equals username
   *   3. '#name' / bare name → exact name match (case-insensitive)
   *   4. exact fname (case-insensitive)
   *   5. unique substring match on name/fname
   * On miss (or ambiguity that a refresh might disambiguate) refresh once and
   * retry, then throw. Multiple substring matches throw with candidate names.
   */
  async resolve(input: string): Promise<RoomRow> {
    const found = this.match(input);
    if (found) return found;

    // Miss (or ambiguous): a stale directory may be hiding the room. Refresh
    // once and retry before giving up.
    await this.refresh();
    const retry = this.match(input);
    if (retry) return retry;

    // Surface ambiguity explicitly if the only reason we failed is multiple
    // substring candidates (match() returns null for both miss and ambiguity).
    const candidates = this.substringCandidates(input);
    if (candidates.length > 1) {
      const names = candidates
        .map((r) => r.name ?? r.fname ?? r.rid)
        .join(', ');
      throw new Error(
        `Room "${input}" is ambiguous — matches multiple rooms: ${names}. ` +
          'Use a more specific name or the exact room id.',
      );
    }

    throw new Error(
      `Room "${input}" not found — use list_rooms/rooms command to see available rooms.`,
    );
  }

  /** List rooms from the cache, refreshing first if stale. */
  async list(filter?: { nameLike?: string; type?: string }): Promise<RoomRow[]> {
    await this.ensureFresh();
    return this.db.findRooms(filter);
  }

  // ---- internals ----------------------------------------------------------

  /** Single-pass resolution against the local cache. Returns null on miss OR
   *  ambiguity; resolve() distinguishes the two for error messaging. */
  private match(input: string): RoomRow | null {
    const trimmed = input.trim();
    if (trimmed === '') return null;

    // 1. exact rid
    const byId = this.db.getRoom(trimmed);
    if (byId) return byId;

    const all = this.db.findRooms();

    // 2. '@username' → DM room by username (name or fname).
    if (trimmed.startsWith('@')) {
      const username = trimmed.slice(1).toLowerCase();
      const dm = all.find(
        (r) =>
          r.t === 'd' &&
          ((r.name ?? '').toLowerCase() === username ||
            (r.fname ?? '').toLowerCase() === username),
      );
      return dm ?? null;
    }

    // 3. '#name' / bare name → exact name (case-insensitive).
    const bare = (trimmed.startsWith('#') ? trimmed.slice(1) : trimmed).toLowerCase();
    const byName = all.find((r) => (r.name ?? '').toLowerCase() === bare);
    if (byName) return byName;

    // 4. exact fname (case-insensitive).
    const byFname = all.find((r) => (r.fname ?? '').toLowerCase() === bare);
    if (byFname) return byFname;

    // 5. unique substring match on name/fname.
    const candidates = this.substringCandidates(trimmed);
    if (candidates.length === 1) return candidates[0]!;
    return null;
  }

  /** Rooms whose name or fname contains `input` (case-insensitive). The '#'/'@'
   *  sigil, if present, is stripped before matching. */
  private substringCandidates(input: string): RoomRow[] {
    const needle = (
      input.startsWith('#') || input.startsWith('@') ? input.slice(1) : input
    )
      .trim()
      .toLowerCase();
    if (needle === '') return [];
    return this.db
      .findRooms()
      .filter(
        (r) =>
          (r.name ?? '').toLowerCase().includes(needle) ||
          (r.fname ?? '').toLowerCase().includes(needle),
      );
  }
}
