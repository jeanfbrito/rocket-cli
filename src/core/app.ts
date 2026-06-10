import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db.js';
import { RcClient } from './rc-client.js';
import { RoomDirectory } from './rooms.js';
import { EmojiDirectory } from './emojis.js';
import { SyncEngine } from './sync.js';
import { SearchService } from './search.js';
import { messageToRow, rowToCompact, rowToCompactWithLink, type RcWireMessage } from './normalize.js';
import type { CompactMessage } from './types.js';

export interface App {
  config: Config;
  db: Db;
  rc: RcClient;
  rooms: RoomDirectory;
  emojis: EmojiDirectory;
  sync: SyncEngine;
  search: SearchService;
}

export function createApp(config?: Config): App {
  const cfg = config ?? loadConfig();
  const db = openDb(cfg.dbPath);
  const rc = new RcClient({ url: cfg.url, token: cfg.token, userId: cfg.userId });
  const rooms = new RoomDirectory(db, rc, cfg.url);
  const emojis = new EmojiDirectory(
    db,
    rc,
    { url: cfg.url, token: cfg.token, userId: cfg.userId },
    cfg.emojiImages,
  );
  const sync = new SyncEngine(db, rc, rooms, {
    ttlSeconds: cfg.ttlSeconds,
    backfillLimit: cfg.backfillLimit,
  });
  const search = new SearchService(db, rc, sync, cfg.url);
  return { config: cfg, db, rc, rooms, emojis, sync, search };
}

export async function sendMessage(
  app: App,
  opts: { target: string; text: string; threadId?: string },
): Promise<CompactMessage> {
  const { target, text, threadId } = opts;

  let resolvedRid: string | undefined;
  const body: { roomId?: string; channel?: string; text?: string; tmid?: string } = { text };

  if (target.startsWith('#') || target.startsWith('@')) {
    body.channel = target;
  } else {
    const roomRow = await app.rooms.resolve(target);
    resolvedRid = roomRow.rid;
    body.roomId = resolvedRid;
  }

  if (threadId !== undefined) {
    body.tmid = threadId;
  }

  const res = await app.rc.postMessage(body);
  const raw: RcWireMessage = res.message ?? {};

  const rid = raw.rid ?? resolvedRid ?? '';
  const row = messageToRow(raw, rid);
  app.db.upsertMessages([row]);
  // Attach a permalink when we can resolve the room (cached after the post).
  const room = app.db.getRoom(rid);
  return room ? rowToCompactWithLink(row, room, app.config.url) : rowToCompact(row);
}
