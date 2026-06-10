import { loadConfig, type Config } from './config.js';
import { openDb, type Db } from './db.js';
import { RcClient } from './rc-client.js';
import { RoomDirectory } from './rooms.js';
import { SyncEngine } from './sync.js';
import { SearchService } from './search.js';
import { messageToRow, rowToCompact } from './normalize.js';
import type { CompactMessage } from './types.js';

export interface App {
  config: Config;
  db: Db;
  rc: RcClient;
  rooms: RoomDirectory;
  sync: SyncEngine;
  search: SearchService;
}

export function createApp(config?: Config): App {
  const cfg = config ?? loadConfig();
  const db = openDb(cfg.dbPath);
  const rc = new RcClient({ url: cfg.url, token: cfg.token, userId: cfg.userId });
  const rooms = new RoomDirectory(db, rc);
  const sync = new SyncEngine(db, rc, rooms, {
    ttlSeconds: cfg.ttlSeconds,
    backfillLimit: cfg.backfillLimit,
  });
  const search = new SearchService(db, rc, sync);
  return { config: cfg, db, rc, rooms, sync, search };
}

interface PostMessageResponse {
  message?: {
    _id?: string;
    rid?: string;
    msg?: string;
    ts?: unknown;
    u?: { _id?: string; username?: string; name?: string };
    tmid?: string;
    tcount?: number;
    tlm?: unknown;
    editedAt?: unknown;
    t?: string;
    attachments?: unknown[];
    _updatedAt?: unknown;
  };
}

export async function sendMessage(
  app: App,
  opts: { target: string; text: string; threadId?: string },
): Promise<CompactMessage> {
  const { target, text, threadId } = opts;

  let resolvedRid: string | undefined;
  let body: Record<string, unknown>;

  if (target.startsWith('#') || target.startsWith('@')) {
    body = { channel: target, text };
  } else {
    const roomRow = await app.rooms.resolve(target);
    resolvedRid = roomRow.rid;
    body = { roomId: resolvedRid, text };
  }

  if (threadId !== undefined) {
    body['tmid'] = threadId;
  }

  const res = await app.rc.post<PostMessageResponse>('/v1/chat.postMessage', body);
  const raw = res.message ?? {};

  const rid = (raw.rid as string | undefined) ?? resolvedRid ?? '';
  const row = messageToRow(raw as Parameters<typeof messageToRow>[0], rid);
  app.db.upsertMessages([row]);
  return rowToCompact(row);
}
