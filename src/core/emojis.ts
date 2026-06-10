// Custom-emoji directory: a local mirror of the server's custom-emoji registry
// (TTL + refresh), plus name resolution and a lazily-populated image cache.
// Mirrors the RoomDirectory pattern — a meta watermark drives a TTL refresh,
// and the cache is read for list/suggest. The MCP/CLI layers use this to
// discover server-specific emoji names that go beyond the standard unicode set,
// and to fetch the emoji images on demand.
//
// GROUND TRUTH (apps/meteor/app/api/server/v1/emoji-custom.ts, emoji-custom.list):
//   - No `updatedSince`  -> { emojis: { update: <full list>, remove: [] } }
//   - With `updatedSince`-> update = emojis with _updatedAt > updatedSince,
//                            remove = emojis deleted after that time.
// So `remove` ONLY populates on the delta path; the initial full sync never
// reports deletions.
//
// IMAGE CACHE (lazy by design): refresh() does the ONE metadata list call and
// returns immediately. It never awaits image downloads — instead it kicks an
// un-awaited background fill (concurrency-limited, errors swallowed to debug)
// so nothing in the request path blocks on the network. Images are also fetched
// on demand by getImage() (one file, in-path) and eagerly by fillImages() (used
// only by the CLI `--export`, where waiting is expected).
import type { Db } from './db.js';
import type { EmojiRow } from './types.js';
import type { RcClient, CustomEmojiWire } from './rc-client.js';
import { fetchEmojiImage, type FilesConfig } from './files.js';
import { log } from './log.js';

/** Meta key holding the ISO timestamp of the last custom-emoji refresh. */
const EMOJIS_REFRESHED_AT = 'emojis_refreshed_at';
// Custom emojis change rarely, so a long TTL is fine. Hardcoded to 3600s: the
// config layer (config.ts) is owned elsewhere and exposes no emoji TTL knob, so
// there is no ROCKET_CLI_EMOJI_TTL_SECONDS wiring — see the task report.
const EMOJIS_TTL_MS = 3600 * 1000;
/** Max concurrent image downloads in the background / export fills. */
const IMAGE_CONCURRENCY = 2;

/** A custom emoji as surfaced to callers (aliases parsed back into an array). */
export interface Emoji {
  id: string;
  name: string;
  aliases: string[];
  extension: string | null;
  updatedAt: string | null;
}

/** An emoji image: raw bytes + MIME type. */
export interface EmojiImage {
  bytes: Buffer;
  contentType: string;
}

/** Convert a wire emoji into a storage row (aliases -> JSON string). */
function wireToRow(e: CustomEmojiWire): EmojiRow {
  return {
    id: e._id,
    name: e.name,
    aliases: JSON.stringify(Array.isArray(e.aliases) ? e.aliases : []),
    extension: e.extension ?? null,
    updated_at: e._updatedAt ?? null,
  };
}

/** Convert a storage row into the caller-facing Emoji (parse aliases JSON). */
function rowToEmoji(row: EmojiRow): Emoji {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(row.aliases) as unknown;
    if (Array.isArray(parsed)) aliases = parsed.map(String);
  } catch {
    // Malformed stored JSON — treat as no aliases rather than throw.
  }
  return {
    id: row.id,
    name: row.name,
    aliases,
    extension: row.extension,
    updatedAt: row.updated_at,
  };
}

/** Length of the shared leading prefix of two strings. */
function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** Run `worker` over `items` with at most `limit` in flight. Never rejects:
 *  each item's outcome is reported via the worker's own error handling. */
async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

export class EmojiDirectory {
  /**
   * @param imagesEnabled  when false, NO image bytes are cached or fetched:
   *   refresh() skips the background fill, getImage() returns undefined without
   *   a network call, and fillImages() throws. Metadata caching is unaffected.
   */
  constructor(
    private readonly db: Db,
    private readonly rc: RcClient,
    private readonly cfg: FilesConfig,
    private readonly imagesEnabled = true,
  ) {}

  /** Whether image caching is enabled (ROCKET_CLI_EMOJI_IMAGES). */
  get imagesAvailable(): boolean {
    return this.imagesEnabled;
  }

  /** The server's public image URL for an emoji, for informative output when
   *  image caching is disabled. */
  serverImageUrl(name: string, extension: string): string {
    const origin = new URL(this.cfg.url).origin;
    return `${origin}/emoji-custom/${encodeURIComponent(name)}.${encodeURIComponent(extension)}`;
  }

  /**
   * Pull custom-emoji METADATA and apply it to the cache. Uses a delta request
   * (`updatedSince` = previous watermark) when a prior refresh exists, else a
   * full list. Applies `update` as upserts and `remove` as deletes, bumps the
   * watermark, then kicks an un-awaited background image fill. Returns as soon
   * as the metadata lands — it NEVER awaits image downloads, so the request
   * path is never blocked on emoji assets.
   */
  async refresh(): Promise<void> {
    const last = this.db.getMeta(EMOJIS_REFRESHED_AT);
    const res = await this.rc.listCustomEmojis(last ?? undefined);
    const update = res.emojis?.update ?? [];
    const remove = res.emojis?.remove ?? [];
    if (update.length > 0) this.db.upsertEmojis(update.map(wireToRow));
    if (remove.length > 0) this.db.removeEmojis(remove.map((e) => e._id));
    this.db.setMeta(EMOJIS_REFRESHED_AT, new Date().toISOString());

    // Fire-and-forget: fill images for rows missing them. Un-awaited; every
    // failure is swallowed to debug so a flaky asset route never surfaces here.
    // Skipped entirely when image caching is disabled.
    if (this.imagesEnabled) {
      void this.fillImages().catch((err) => {
        log.debug(`emoji image background fill failed: ${String(err)}`);
      });
    }
  }

  /** Refresh only if the emoji cache is older than the TTL. */
  async ensureFresh(): Promise<void> {
    const last = this.db.getMeta(EMOJIS_REFRESHED_AT);
    if (last) {
      const age = Date.now() - Date.parse(last);
      if (Number.isFinite(age) && age < EMOJIS_TTL_MS) return;
    }
    await this.refresh();
  }

  /**
   * List cached custom emojis (METADATA only — never touches images),
   * refreshing first if stale.
   */
  async list(filter?: string): Promise<Emoji[]> {
    await this.ensureFresh();
    return this.db.findEmojis(filter).map(rowToEmoji);
  }

  /**
   * Resolve an emoji image by name or alias. Cached blob -> returned instantly.
   * On a miss (row exists but image not cached) we fetch exactly that ONE image
   * in-path, store it, and return it — a single small file, acceptable latency.
   * Returns undefined if no emoji matches the name/alias at all. Throws (mapped)
   * only if the single fetch fails; the caller decides how to degrade.
   */
  async getImage(name: string): Promise<EmojiImage | undefined> {
    if (!this.imagesEnabled) return undefined;
    await this.ensureFresh();
    const emoji = this.matchByNameOrAlias(name);
    if (!emoji) return undefined;

    const cached = this.db.getEmojiImage(emoji.id);
    if (cached) return { bytes: cached.image, contentType: cached.contentType };

    if (!emoji.extension) return undefined;
    const fetched = await fetchEmojiImage(this.cfg, emoji.name, emoji.extension);
    this.db.setEmojiImage(emoji.id, fetched.bytes, fetched.contentType);
    return { bytes: fetched.bytes, contentType: fetched.contentType };
  }

  /** Look up a single emoji (caller-facing shape) by exact name or alias. */
  lookup(name: string): Emoji | undefined {
    return this.matchByNameOrAlias(name);
  }

  /**
   * Fetch + store images for every emoji whose image is not yet cached, with
   * bounded concurrency. Per-emoji failures are logged and skipped (image is an
   * enhancement). `onProgress` is invoked after each attempt (done/total).
   * Returns the number of images successfully stored. Used by the background
   * fill (un-awaited) and the CLI `--export` (awaited).
   */
  async fillImages(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (!this.imagesEnabled) {
      throw new Error('image caching disabled (ROCKET_CLI_EMOJI_IMAGES=false)');
    }
    const missing = this.db
      .findEmojis()
      .map(rowToEmoji)
      .filter((e) => e.extension != null && this.db.getEmojiImage(e.id) === undefined);

    let done = 0;
    let stored = 0;
    await mapLimit(missing, IMAGE_CONCURRENCY, async (emoji) => {
      try {
        const fetched = await fetchEmojiImage(this.cfg, emoji.name, emoji.extension!);
        this.db.setEmojiImage(emoji.id, fetched.bytes, fetched.contentType);
        stored++;
      } catch (err) {
        log.debug(`emoji image fetch failed for ${emoji.name}: ${String(err)}`);
      } finally {
        done++;
        onProgress?.(done, missing.length);
      }
    });
    return stored;
  }

  /**
   * Up to 5 custom-emoji names close to `input`, for error enrichment when a
   * reaction is rejected. Case-insensitive. Matches in priority order:
   *   1. exact / prefix match on name
   *   2. substring match either direction (name in input, or input in name)
   *   3. same checks against aliases
   * No external distance library — simple substring/prefix is enough to point
   * a caller at the right name after a typo. Reads the cache as-is (no refresh).
   */
  suggest(input: string): string[] {
    const needle = input.trim().replace(/^:+|:+$/g, '').toLowerCase();
    if (needle === '') return [];

    const rows = this.db.findEmojis();
    const scored: Array<{ name: string; rank: number }> = [];

    for (const row of rows) {
      const emoji = rowToEmoji(row);
      const candidates = [emoji.name, ...emoji.aliases];
      let best = Infinity;
      for (const c of candidates) {
        const cl = c.toLowerCase();
        if (cl === needle) best = Math.min(best, 0);
        else if (cl.startsWith(needle) || needle.startsWith(cl)) best = Math.min(best, 1);
        else if (cl.includes(needle) || needle.includes(cl)) best = Math.min(best, 2);
        else {
          // Typo tolerance: a substantial shared prefix (>= 3 chars and >= 60%
          // of the shorter string) catches single-char typos like
          // 'rockt' -> 'rocketcli'. No external edit-distance lib.
          const p = commonPrefixLen(cl, needle);
          if (p >= 3 && p >= 0.6 * Math.min(cl.length, needle.length)) {
            best = Math.min(best, 3);
          }
        }
      }
      if (Number.isFinite(best)) scored.push({ name: emoji.name, rank: best });
    }

    scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    return scored.slice(0, 5).map((s) => s.name);
  }

  // ---- internals ----------------------------------------------------------

  /** Match a single cached emoji by exact name OR alias (case-insensitive). */
  private matchByNameOrAlias(name: string): Emoji | undefined {
    const needle = name.trim().replace(/^:+|:+$/g, '').toLowerCase();
    if (needle === '') return undefined;
    for (const row of this.db.findEmojis()) {
      const emoji = rowToEmoji(row);
      if (emoji.name.toLowerCase() === needle) return emoji;
      if (emoji.aliases.some((a) => a.toLowerCase() === needle)) return emoji;
    }
    return undefined;
  }
}
