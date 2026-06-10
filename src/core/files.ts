// File upload / download against Rocket.Chat. The api-client's upload() is
// XHR/browser-only, so these flows use native fetch + FormData + Blob directly
// (Node >= 20) rather than going through RcClient. This module is IO-pure with
// respect to the app: config in, result out, no DB dependency.
//
// VERIFIED (Rocket.Chat source):
//  - Upload is two-step:
//      1. POST {url}/api/v1/rooms.media/{rid}  (multipart, field `file`)
//         -> { success, file: { _id, url } }   (pending, expires in 24h)
//      2. POST {url}/api/v1/rooms.mediaConfirm/{rid}/{fileId}  (JSON body)
//         -> { success, message }               (creates the message)
//    Confirm body: `description` / `fileName` consumed by the route; the rest
//    (msg, tmid, customFields, ...) flow into sendFileMessage as msgData.
//  - Download: GET on the attachment path (`/file-upload/{id}/{name}`) with
//    `x-user-id` + `x-auth-token` headers authenticates (FileUpload.ts fallback).
import { createWriteStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { mapRcError } from './errors.js';
import type { RcWireMessage } from './normalize.js';

/** Auth + endpoint config slice these flows need (subset of Config). */
export interface FilesConfig {
  url: string;
  token: string;
  userId: string;
}

export interface UploadOpts {
  rid: string;
  filePath: string;
  text?: string;
  description?: string;
  threadId?: string;
  fileName?: string;
}

export interface UploadResult {
  message: RcWireMessage;
}

export interface DownloadOpts {
  fileUrl: string;
  savePath?: string;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  contentType?: string;
}

/** 100 MB ceiling — a client-side guard, independent of the server's setting. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Minimal extension -> MIME map; everything else falls back to octet-stream. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function contentTypeFor(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function authHeaders(cfg: FilesConfig): Record<string, string> {
  return {
    'X-Auth-Token': cfg.token,
    'X-User-Id': cfg.userId,
  };
}

/**
 * Upload a local file to a room (optionally as a thread reply) and create the
 * message. Two-step: rooms.media (multipart) then rooms.mediaConfirm (JSON).
 * Validates the file exists, is a regular file, and is under 100 MB before
 * sending. Non-2xx responses are mapped through mapRcError.
 */
export async function uploadFile(cfg: FilesConfig, opts: UploadOpts): Promise<UploadResult> {
  const { rid, filePath } = opts;

  // ---- validate the local file -------------------------------------------
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const st = statSync(filePath);
  if (!st.isFile()) {
    throw new Error(`Not a regular file: ${filePath}`);
  }
  if (st.size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `File too large: ${filePath} is ${st.size} bytes (limit ${MAX_UPLOAD_BYTES}).`,
    );
  }

  const name = opts.fileName ?? basename(filePath);
  const type = contentTypeFor(filePath);
  const bytes = await readFile(filePath);

  // ---- step 1: rooms.media (multipart upload) -----------------------------
  const mediaUrl = `${cfg.url}/api/v1/rooms.media/${encodeURIComponent(rid)}`;
  const mediaCtx = `POST /v1/rooms.media/${rid} @ ${cfg.url}`;

  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), name);

  let mediaRes: Response;
  try {
    mediaRes = await fetch(mediaUrl, {
      method: 'POST',
      headers: authHeaders(cfg),
      body: form,
    });
  } catch (err) {
    throw await mapRcError(err, mediaCtx);
  }
  if (!mediaRes.ok) {
    throw await mapRcError(mediaRes, mediaCtx);
  }

  const mediaBody = (await mediaRes.json()) as { file?: { _id?: string } };
  const fileId = mediaBody.file?._id;
  if (!fileId) {
    throw new Error(`Upload to ${mediaCtx} returned no file id.`);
  }

  // ---- step 2: rooms.mediaConfirm (create the message) --------------------
  const confirmUrl = `${cfg.url}/api/v1/rooms.mediaConfirm/${encodeURIComponent(
    rid,
  )}/${encodeURIComponent(fileId)}`;
  const confirmCtx = `POST /v1/rooms.mediaConfirm/${rid}/${fileId} @ ${cfg.url}`;

  const confirmBody: Record<string, string> = {};
  if (opts.text !== undefined) confirmBody.msg = opts.text;
  if (opts.description !== undefined) confirmBody.description = opts.description;
  if (opts.threadId !== undefined) confirmBody.tmid = opts.threadId;
  if (opts.fileName !== undefined) confirmBody.fileName = opts.fileName;

  let confirmRes: Response;
  try {
    confirmRes = await fetch(confirmUrl, {
      method: 'POST',
      headers: { ...authHeaders(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify(confirmBody),
    });
  } catch (err) {
    throw await mapRcError(err, confirmCtx);
  }
  if (!confirmRes.ok) {
    throw await mapRcError(confirmRes, confirmCtx);
  }

  const confirmJson = (await confirmRes.json()) as { message?: RcWireMessage };
  return { message: confirmJson.message ?? {} };
}

/**
 * Download an attachment to local disk. `fileUrl` may be a path
 * (`/file-upload/...`) or an absolute URL on the same origin as `cfg.url`;
 * other origins are refused. Authenticates with the two RC headers, follows
 * redirects, writes to `savePath` (or `~/Downloads/<sanitized-name>`), creates
 * the target dir, and never overwrites silently (suffixes -1, -2, ...).
 */
export async function downloadFile(
  cfg: FilesConfig,
  opts: DownloadOpts,
): Promise<DownloadResult> {
  const { fileUrl } = opts;
  const origin = new URL(cfg.url).origin;

  // Resolve fileUrl to an absolute URL on the configured origin.
  let target: URL;
  if (/^https?:\/\//i.test(fileUrl)) {
    target = new URL(fileUrl);
    if (target.origin !== origin) {
      throw new Error('refusing cross-origin download');
    }
  } else {
    target = new URL(fileUrl.startsWith('/') ? fileUrl : `/${fileUrl}`, origin);
  }

  const ctx = `GET ${target.pathname} @ ${origin}`;

  let res: Response;
  try {
    res = await fetch(target, {
      method: 'GET',
      headers: {
        'x-auth-token': cfg.token,
        'x-user-id': cfg.userId,
      },
      redirect: 'follow',
    });
  } catch (err) {
    throw await mapRcError(err, ctx);
  }
  if (!res.ok) {
    throw await mapRcError(res, ctx);
  }
  if (!res.body) {
    throw new Error(`Download from ${ctx} returned an empty body.`);
  }

  const contentType = res.headers.get('content-type') ?? undefined;

  // Determine the destination path.
  let outPath: string;
  if (opts.savePath !== undefined) {
    outPath = opts.savePath;
  } else {
    const fromUrl = sanitizeFilename(decodeURIComponent(basename(target.pathname)));
    outPath = join(homedir(), 'Downloads', fromUrl || 'download');
  }

  await mkdir(dirname(outPath), { recursive: true });
  outPath = await uniquePath(outPath);

  const sink = createWriteStream(outPath);
  await pipeline(Readable.fromWeb(res.body as WebReadableStream), sink);

  const written = await stat(outPath);
  return { path: outPath, bytes: written.size, contentType };
}

/** Strip path traversal and separators from a URL-derived filename. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, '') // no separators
    .replace(/\.\.+/g, '') // collapse '..' sequences
    .trim();
}

/** Return `candidate` if free, else `candidate-1`, `-2`, ... before the ext. */
async function uniquePath(candidate: string): Promise<string> {
  if (!existsSync(candidate)) return candidate;
  const dir = dirname(candidate);
  const ext = extname(candidate);
  const stem = basename(candidate, ext);
  for (let i = 1; ; i++) {
    const next = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(next)) return next;
  }
}
