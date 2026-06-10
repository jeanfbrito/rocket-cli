#!/usr/bin/env tsx
/**
 * Realistic-usage seeder for the rocket-cli test server.
 *
 * Turns a near-empty Rocket.Chat instance into a believable multi-user
 * workspace so every rocket-cli feature can be exercised against true
 * multi-user state (unread, mentions, threads, DMs) — none of which the
 * admin's own messages can produce for the admin's own account.
 *
 * Uses the admin PAT from .env (loaded via the CLI's loadConfig) to create
 * personas, then logs each persona in so content can be posted *as them*,
 * generating real unread/mention/thread state for `jean`.
 *
 * IDEMPOTENT: check-before-create everywhere. Safe to run twice. Persona
 * passwords are generated once and stored in scripts/.seed-credentials.json
 * (gitignored) so re-runs reuse the same logins.
 *
 *   npm run seed
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';

// ---------------------------------------------------------------------------
// Small typed REST surface (admin + per-persona), raw fetch like core/files.ts
// ---------------------------------------------------------------------------

interface Auth {
  token: string;
  userId: string;
}

const cfg = loadConfig();
const BASE = cfg.url; // already trailing-slash-stripped by loadConfig
const ADMIN: Auth = { token: cfg.token, userId: cfg.userId };

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CRED_PATH = join(SCRIPT_DIR, '.seed-credentials.json');

function authHeaders(a: Auth): Record<string, string> {
  return { 'X-Auth-Token': a.token, 'X-User-Id': a.userId };
}

async function api<T = any>(
  method: 'GET' | 'POST',
  path: string,
  opts: { auth?: Auth; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const a = opts.auth ?? ADMIN;
  let url = `${BASE}/api/v1/${path}`;
  if (opts.query) {
    const qs = new URLSearchParams(opts.query).toString();
    if (qs) url += `?${qs}`;
  }
  const headers: Record<string, string> = { ...authHeaders(a) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} -> non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || json.success === false) {
    const msg = json.error ?? json.message ?? text.slice(0, 200);
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
  }
  return json as T;
}

// jitter to stay well under the admin rate limits during the bulk posting
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Persona definitions + credential store
// ---------------------------------------------------------------------------

interface PersonaSpec {
  username: string;
  name: string;
  email: string;
}

const PERSONAS: PersonaSpec[] = [
  { username: 'ana.dev', name: 'Ana Silva (dev)', email: 'ana.dev@seed.local' },
  { username: 'bruno.qa', name: 'Bruno Costa (qa)', email: 'bruno.qa@seed.local' },
  { username: 'carla.pm', name: 'Carla Mendes (pm)', email: 'carla.pm@seed.local' },
  { username: 'diego.ops', name: 'Diego Rocha (ops)', email: 'diego.ops@seed.local' },
];

interface CredFile {
  password: string;
  // resolved at runtime, not persisted as auth (tokens are session-scoped)
  users: Record<string, string>; // username -> _id (informational)
}

function loadOrCreateCreds(): CredFile {
  if (existsSync(CRED_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CRED_PATH, 'utf8'));
      if (parsed && typeof parsed.password === 'string') {
        return { password: parsed.password, users: parsed.users ?? {} };
      }
    } catch {
      /* fall through to regenerate */
    }
  }
  // One shared strong password for all personas — printed to stderr only.
  const password = `Seed-${randomBytes(9).toString('base64url')}!`;
  return { password, users: {} };
}

function saveCreds(c: CredFile): void {
  mkdirSync(dirname(CRED_PATH), { recursive: true });
  writeFileSync(CRED_PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Idempotent primitives
// ---------------------------------------------------------------------------

/** Find a user by username, return its _id or null. */
async function findUser(username: string): Promise<string | null> {
  try {
    const r = await api<{ user?: { _id: string } }>('GET', 'users.info', {
      query: { username },
    });
    return r.user?._id ?? null;
  } catch (e) {
    // users.info 400s when the user does not exist
    return null;
  }
}

/** Create a persona if missing; always (re)set the password so login works. */
async function ensureUser(spec: PersonaSpec, password: string): Promise<string> {
  const existing = await findUser(spec.username);
  if (existing) {
    // Re-assert password + verified state so re-runs with a reused credential
    // file keep working even if something drifted.
    await api('POST', 'users.update', {
      body: {
        userId: existing,
        data: { password, verified: true },
      },
    });
    return existing;
  }
  const r = await api<{ user: { _id: string } }>('POST', 'users.create', {
    body: {
      username: spec.username,
      name: spec.name,
      email: spec.email,
      password,
      verified: true,
      active: true,
      roles: ['user'],
      requirePasswordChange: false,
      joinDefaultChannels: false,
      sendWelcomeEmail: false,
    },
  });
  return r.user._id;
}

/** Log a persona in -> session Auth (token + userId) for posting as them. */
async function loginAs(username: string, password: string): Promise<Auth> {
  const r = await api<{ data: { userId: string; authToken: string } }>(
    'POST',
    'login',
    { body: { user: username, password } },
  );
  return { userId: r.data.userId, token: r.data.authToken };
}

const EMAIL_2FA_SETTING = 'Accounts_TwoFactorAuthentication_By_Email_Enabled';
const RATE_LIMITER_SETTING = 'API_Enable_Rate_Limiter';

/** Read a server setting's value (admin). */
async function getSetting(id: string): Promise<unknown> {
  const r = await api<{ value: unknown }>('GET', `settings/${id}`);
  return r.value;
}

/** Update a server setting's value (admin). */
async function setSetting(id: string, value: unknown): Promise<void> {
  await api('POST', `settings/${id}`, { body: { value } });
}

/**
 * Run `fn` with a boolean server setting forced to `temp`, restoring the prior
 * value afterwards (try/finally — restores on success OR failure, so the
 * server posture is unchanged after the run). No-op if the setting is missing
 * or already at `temp`. Used to relax two policies for the seed window:
 *   - email-2FA: the server demands a TOTP/email code on EVERY password login
 *     when on, blocking programmatic persona logins.
 *   - the API rate limiter: 10 calls/60s/endpoint is far below the hundreds of
 *     posts this seeder issues; honoring it would take hours.
 * Both are restored to their original value when seeding finishes.
 */
async function withSetting<T>(id: string, temp: boolean, fn: () => Promise<T>): Promise<T> {
  let prior: unknown;
  try {
    prior = await getSetting(id);
  } catch {
    return fn(); // setting not readable -> just run
  }
  const toggled = prior !== temp;
  if (toggled) await setSetting(id, temp);
  try {
    return await fn();
  } finally {
    if (toggled) {
      try {
        await setSetting(id, prior);
      } catch {
        process.stderr.write(
          `WARNING: failed to restore ${id}=${String(prior)}; restore it manually in admin settings.\n`,
        );
      }
    }
  }
}

type RoomType = 'c' | 'p' | 'd';

interface RoomRef {
  rid: string;
  name: string;
  type: RoomType;
}

/**
 * Ensure a public channel exists with the given members; return its rid.
 * Existence is checked as the CREATOR (info routes require membership), and a
 * `duplicate-channel-name` on create is recovered by re-resolving the rid — so
 * a partial prior run that already created the room is fully idempotent.
 */
async function ensureChannel(
  name: string,
  members: string[],
  creator: Auth,
): Promise<RoomRef> {
  const find = async (): Promise<string | null> => {
    try {
      const info = await api<{ channel: { _id: string } }>('GET', 'channels.info', {
        auth: creator,
        query: { roomName: name },
      });
      return info.channel._id;
    } catch {
      return null;
    }
  };
  const existing = await find();
  if (existing) return { rid: existing, name, type: 'c' };
  try {
    const r = await api<{ channel: { _id: string } }>('POST', 'channels.create', {
      auth: creator,
      body: { name, members },
    });
    return { rid: r.channel._id, name, type: 'c' };
  } catch (e) {
    const again = await find();
    if (again) return { rid: again, name, type: 'c' };
    throw e;
  }
}

/** Ensure a private group exists with the given members; return its rid. */
async function ensureGroup(
  name: string,
  members: string[],
  creator: Auth,
): Promise<RoomRef> {
  const find = async (): Promise<string | null> => {
    try {
      const info = await api<{ group: { _id: string } }>('GET', 'groups.info', {
        auth: creator,
        query: { roomName: name },
      });
      return info.group._id;
    } catch {
      return null;
    }
  };
  const existing = await find();
  if (existing) return { rid: existing, name, type: 'p' };
  try {
    const r = await api<{ group: { _id: string } }>('POST', 'groups.create', {
      auth: creator,
      body: { name, members },
    });
    return { rid: r.group._id, name, type: 'p' };
  } catch (e) {
    const again = await find();
    if (again) return { rid: again, name, type: 'p' };
    throw e;
  }
}

/**
 * Add a user (by id) to a channel/group, ignoring "already in" errors.
 * For private groups the inviter MUST be a member, so pass `inviter` (a member's
 * session); public channels accept the admin default.
 */
async function inviteToRoom(room: RoomRef, userId: string, inviter?: Auth): Promise<void> {
  const endpoint = room.type === 'c' ? 'channels.invite' : 'groups.invite';
  try {
    await api('POST', endpoint, { auth: inviter, body: { roomId: room.rid, userId } });
  } catch (e) {
    // Already a member -> server returns an error; treat as success.
  }
}

/** Open a DM from `from` to the target username; return its rid (idempotent). */
async function ensureDm(from: Auth, targetUsername: string): Promise<string> {
  const r = await api<{ room: { _id: string } }>('POST', 'im.create', {
    auth: from,
    body: { username: targetUsername },
  });
  return r.room._id;
}

/** Open a multi-party DM from `from` to several usernames; return its rid. */
async function ensureGroupDm(from: Auth, usernames: string[]): Promise<string> {
  const r = await api<{ room: { _id: string } }>('POST', 'im.create', {
    auth: from,
    body: { usernames: usernames.join(',') },
  });
  return r.room._id;
}

interface PostedMsg {
  _id: string;
  rid: string;
}

/** Post a message as a given auth; returns message id + rid. */
async function post(
  auth: Auth,
  roomId: string,
  text: string,
  tmid?: string,
): Promise<PostedMsg> {
  const body: Record<string, unknown> = { roomId, text };
  if (tmid) body.tmid = tmid;
  const r = await api<{ message: { _id: string; rid: string } }>(
    'POST',
    'chat.postMessage',
    { auth, body },
  );
  await sleep(60);
  return { _id: r.message._id, rid: r.message.rid };
}

/** React to a message as a given persona. */
async function react(auth: Auth, messageId: string, emoji: string): Promise<void> {
  await api('POST', 'chat.react', { auth, body: { messageId, emoji, shouldReact: true } });
  await sleep(60);
}

/** Edit a message's text as the author (chat.update). */
async function editMsg(auth: Auth, roomId: string, msgId: string, text: string): Promise<void> {
  await api('POST', 'chat.update', { auth, body: { roomId, msgId, text } });
  await sleep(60);
}

/** Delete a message as the author (chat.delete). */
async function deleteMsg(auth: Auth, roomId: string, msgId: string): Promise<void> {
  await api('POST', 'chat.delete', { auth, body: { roomId, msgId, asUser: true } });
  await sleep(60);
}

/** Set a persona's presence status + status text (users.setStatus). */
async function setStatus(
  auth: Auth,
  status: 'online' | 'away' | 'busy' | 'offline',
  message: string,
): Promise<void> {
  await api('POST', 'users.setStatus', { auth, body: { status, message } });
  await sleep(60);
}

/** Ensure a custom emoji exists by name; create from a tiny PNG if missing. */
async function ensureCustomEmoji(name: string): Promise<boolean> {
  const list = await api<{ emojis: { update: { name: string }[] } }>(
    'GET',
    'emoji-custom.list',
  );
  if (list.emojis.update.some((e) => e.name === name)) return true;
  // Register it (admin) from the tiny PNG. emoji.create is multipart, field `emoji`.
  try {
    const form = new FormData();
    form.append('emoji', new Blob([TINY_PNG], { type: 'image/png' }), `${name}.png`);
    form.append('name', name);
    form.append('aliases', '');
    const res = await fetch(`${BASE}/api/v1/emoji-custom.create`, {
      method: 'POST',
      headers: authHeaders(ADMIN),
      body: form,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Post a message that quotes another message, as a real quote attachment. */
async function postQuote(
  auth: Auth,
  roomId: string,
  quotedMsgId: string,
  _quotedRid: string,
  text: string,
): Promise<PostedMsg> {
  // The canonical quote shape is an attachment with message_link to the
  // permalink. Build the chat.getMessage permalink form the server understands.
  const permalink = `${BASE}/channel/_?msg=${quotedMsgId}`;
  const body = {
    roomId,
    text,
    attachments: [
      {
        message_link: permalink,
        text: '> quoted message',
      },
    ],
  };
  const r = await api<{ message: { _id: string; rid: string } }>('POST', 'chat.postMessage', {
    auth,
    body,
  });
  await sleep(60);
  return { _id: r.message._id, rid: r.message.rid };
}

/** A 1x1 transparent PNG (decoded from base64) for image-upload + emoji tests. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Two-step file upload as a persona (rooms.media -> rooms.mediaConfirm). */
async function uploadFile(
  auth: Auth,
  rid: string,
  fileName: string,
  contents: Buffer | string,
  contentType: string,
  message: string,
  tmid?: string,
): Promise<void> {
  const form = new FormData();
  // Buffer is not a structural BlobPart under strict lib types; wrap binary as
  // a Uint8Array, leave strings as-is.
  const part: BlobPart = typeof contents === 'string' ? contents : new Uint8Array(contents);
  form.append('file', new Blob([part], { type: contentType }), fileName);
  const media = await fetch(`${BASE}/api/v1/rooms.media/${encodeURIComponent(rid)}`, {
    method: 'POST',
    headers: authHeaders(auth),
    body: form,
  });
  const mediaJson: any = await media.json();
  if (!media.ok || !mediaJson?.file?._id) {
    throw new Error(`rooms.media failed: ${media.status} ${JSON.stringify(mediaJson).slice(0, 200)}`);
  }
  const fileId = mediaJson.file._id;
  // NOTE: the filename is already fixed by the multipart upload; including
  // `fileName` in the confirm body fails Match validation on 7.x, so we only
  // send msg/description/tmid here.
  const confirm: Record<string, string> = { msg: message, description: message };
  if (tmid) confirm.tmid = tmid;
  await api('POST', `rooms.mediaConfirm/${encodeURIComponent(rid)}/${encodeURIComponent(fileId)}`, {
    auth,
    body: confirm,
  });
  await sleep(60);
}

// ---------------------------------------------------------------------------
// Conversation fabric — only posts when a room looks empty, so re-runs do not
// pile up duplicate chatter. We gate per-room on existing message count.
// ---------------------------------------------------------------------------

/** Count threads (main thread messages) in a room — used as a finer idempotency
 *  gate for the engineering block, which posts several threads after its plain
 *  chatter. Gating on thread count (not message count) means a run that died
 *  mid-chatter still re-seeds the threads on the next run. */
async function roomThreadCount(rid: string, auth?: Auth): Promise<number> {
  try {
    const r = await api<{ threads: unknown[] }>('GET', 'chat.getThreadsList', {
      auth,
      query: { rid, count: '50' },
    });
    return r.threads?.length ?? 0;
  } catch {
    return 0;
  }
}

async function roomMessageCount(room: RoomRef, auth?: Auth): Promise<number> {
  const endpoint =
    room.type === 'c'
      ? 'channels.history'
      : room.type === 'p'
        ? 'groups.history'
        : 'im.history';
  try {
    const r = await api<{ messages: unknown[] }>('GET', endpoint, {
      auth,
      query: { roomId: room.rid, count: '5' },
    });
    return r.messages?.length ?? 0;
  } catch {
    return 0;
  }
}

interface SeedReport {
  engineering: {
    rid: string;
    mentionThreadId?: string;
    mentionMsgId?: string;
    longThreadId?: string;
    editedMsgId?: string;
    deletedMsgId?: string;
  };
  incidents: { rid: string; mentionMsgId?: string };
  random: { rid: string; quotedJeanMsgId?: string };
  leadership: { rid: string; mentionMsgId?: string };
  dmAnaId?: string;
  dmDiegoId?: string;
  groupDmId?: string;
  secretOpsRid?: string;
  personaDmRid?: string;
}

async function main(): Promise<void> {
  const creds = loadOrCreateCreds();
  const log = (s: string) => process.stdout.write(s + '\n');

  log('Seeding realistic workspace state...');

  // 1. Personas ------------------------------------------------------------
  // Create/repair the persona accounts first (admin; re-asserts password), then
  // persist the credential file BEFORE logins so a partial failure still keeps
  // a reusable password. Logins run with email-2FA temporarily disabled — the
  // server otherwise demands a TOTP/email code on every password login.
  const userIds: Record<string, string> = {};
  const sessions: Record<string, Auth> = {};
  for (const p of PERSONAS) {
    const id = await ensureUser(p, creds.password);
    userIds[p.username] = id;
    creds.users[p.username] = id;
  }
  saveCreds(creds);
  await withSetting(EMAIL_2FA_SETTING, false, async () => {
    for (const p of PERSONAS) {
      sessions[p.username] = await loginAs(p.username, creds.password);
    }
  });
  const ana = sessions['ana.dev']!;
  const bruno = sessions['bruno.qa']!;
  const carla = sessions['carla.pm']!;
  const diego = sessions['diego.ops']!;

  // Rooms + conversation fabric run with the API rate limiter relaxed (10
  // calls/60s/endpoint would otherwise stall the hundreds of posts for hours);
  // the original value is restored in withSetting's finally.
  const report = await withSetting(RATE_LIMITER_SETTING, false, async () => {
  // 2. Rooms ---------------------------------------------------------------
  const personaUsernames = PERSONAS.map((p) => p.username);
  const engineering = await ensureChannel('engineering', personaUsernames, ana);
  const random = await ensureChannel('random', personaUsernames, ana);
  const incidents = await ensureChannel('incidents', personaUsernames, diego);
  // private leadership: created by carla, jean + carla are members
  const leadership = await ensureGroup('leadership', ['carla.pm'], carla);

  // jean must be a member of every room so unread/mentions land for jean
  for (const room of [engineering, random, incidents]) {
    await inviteToRoom(room, ADMIN.userId);
  }
  // leadership is private — carla (a member) must issue the invite, not admin
  await inviteToRoom(leadership, ADMIN.userId, carla);
  // ensure carla also in leadership (creator already is) + invite all personas
  // to the public channels (members[] at create handles new rooms; this covers
  // pre-existing rooms on re-run)
  for (const room of [engineering, random, incidents]) {
    for (const u of personaUsernames) await inviteToRoom(room, userIds[u]!);
  }

  const report: SeedReport = {
    engineering: { rid: engineering.rid },
    incidents: { rid: incidents.rid },
    random: { rid: random.rid },
    leadership: { rid: leadership.rid },
  };

  // 3. Conversation fabric -------------------------------------------------

  // --- #engineering -------------------------------------------------------
  // Gate on thread count (the block creates 4 threads): a partial prior run
  // that posted only chatter still re-seeds the threads here. The plain
  // chatter is cleared first if threads are missing but messages exist, so a
  // re-seed does not pile up duplicate chatter.
  if ((await roomThreadCount(engineering.rid)) < 4) {
    if ((await roomMessageCount(engineering)) > 0) {
      // partial prior run: wipe and reseed cleanly
      await api('POST', 'rooms.cleanHistory', {
        body: {
          roomId: engineering.rid,
          latest: new Date().toISOString(),
          oldest: '2000-01-01T00:00:00.000Z',
          limit: 5000,
          excludePinned: false,
        },
      });
    }
    const eng = engineering.rid;
    await post(ana, eng, 'morning all — pushing the auth refactor branch for review today');
    await post(bruno, eng, 'nice, i will pick up the regression pass once CI is green');
    await post(diego, eng, 'heads up: staging redeploy at 10:00, ~3min blip expected');
    await post(carla, eng, 'thanks diego. ana, is the auth work still on track for the sprint demo?');
    await post(ana, eng, 'yes, just polishing the token rotation path');
    await post(bruno, eng, 'found a flaky test in the session suite, retrying');
    await post(diego, eng, 'grafana shows memory creeping on api-2, watching it');
    await post(carla, eng, 'lets keep the demo scope tight — login + rotation only');
    await post(ana, eng, 'agreed. PR is up: feature/auth-rotation');
    await post(bruno, eng, 'reviewing now');
    await post(diego, eng, 'redeploy done, staging healthy');
    await post(ana, eng, 'merged. thanks for the quick review bruno');
    await post(bruno, eng, 'do we have a changelog entry for this?');
    await post(carla, eng, 'i will add it to the release notes');
    await post(diego, eng, 'bumping the node base image to 20.14 in the dockerfile');
    await post(ana, eng, 'careful, that broke the sharp build last time');
    await post(diego, eng, 'pinned the prebuilt binary this time, should be fine');
    await post(bruno, eng, 'smoke tests pass on the new image locally');
    await post(carla, eng, 'great. sprint review moved to thursday 14:00');
    await post(ana, eng, 'noted');
    await post(diego, eng, 'rotating the staging DB creds tonight, low traffic window');
    await post(bruno, eng, 'should i hold the nightly e2e run then?');
    await post(diego, eng, 'yes, skip tonight, resume tomorrow');
    await post(ana, eng, 'pushed a fix for the rotation race condition');
    await post(carla, eng, 'demo dry-run tomorrow morning, everyone available?');
    await post(bruno, eng, 'i am, 09:30 works');
    await post(diego, eng, 'same here');
    await post(ana, eng, 'works for me');

    // Thread 1: started by ana, 6+ replies from multiple personas, one MENTIONS @jean
    const t1 = await post(ana, eng, 'deploy pipeline broken? prod deploy job has been red for 20 min');
    report.engineering.mentionThreadId = t1._id;
    await post(diego, eng, 'looking — the artifact upload step is timing out', t1._id);
    await post(bruno, eng, 'i saw that too, the registry was slow earlier', t1._id);
    await post(diego, eng, 'confirmed, registry latency spike. retrying the job', t1._id);
    await post(carla, eng, 'do we need to notify stakeholders or is this internal-only?', t1._id);
    const mentionReply = await post(
      ana,
      eng,
      '@jean can you approve the hotfix deploy when you get a sec? blocking the release',
      t1._id,
    );
    report.engineering.mentionMsgId = mentionReply._id;
    await post(diego, eng, 'job is green now after retry, pipeline unblocked', t1._id);
    await post(bruno, eng, 'verified the deployed build matches the tag', t1._id);

    // Thread 2: 4 replies, jean NOT mentioned
    const t2 = await post(bruno, eng, 'should we standardize on vitest across all services?');
    await post(ana, eng, 'yes please, jest config drift is painful', t2._id);
    await post(diego, eng, 'the ops scripts still use tap though', t2._id);
    await post(carla, eng, 'lets file a tech-debt ticket and do it next sprint', t2._id);
    await post(bruno, eng, 'ticket created: TD-412', t2._id);

    // Thread 3 (thread-unread / tunread path): jean REPLIES, then personas
    // post AFTER him -> the server marks jean's subscription tunread for this
    // thread. This is the only way to populate threadUnreads for jean.
    const t3 = await post(carla, eng, 'who owns the search-perf spike this sprint?');
    await post(ADMIN, eng, 'i can take the search-perf spike', t3._id); // jean replies (his PAT)
    await post(ana, eng, 'great, i will pair with you on the indexing part', t3._id);
    await post(diego, eng, 'i will pull the prod query latency numbers for you', t3._id);
    await post(bruno, eng, 'i have a repro dataset that surfaces the slow path', t3._id);

    // Long thread: 30+ replies -> exercises thread pagination / self-heal
    const tLong = await post(diego, eng, 'thread: rolling notes for the gateway migration');
    report.engineering.longThreadId = tLong._id;
    const speakers = [ana, bruno, carla, diego];
    for (let i = 1; i <= 32; i++) {
      const sp = speakers[i % speakers.length]!;
      await post(sp, eng, `migration note #${i}: step ${i} verified, moving on`, tLong._id);
    }

    // Edited message: persona posts, then edits -> "(edited)" delta-sync path
    const edited = await post(ana, eng, 'standup is at 9am tomrrow'); // typo
    await editMsg(ana, eng, edited._id, 'standup is at 9:30am tomorrow (corrected time)');
    report.engineering.editedMsgId = edited._id;

    // Deleted message: persona posts then deletes -> delta marks deleted
    const doomed = await post(bruno, eng, 'IGNORE THIS — accidental paste of a secret token xyz123');
    await deleteMsg(bruno, eng, doomed._id);
    report.engineering.deletedMsgId = doomed._id;

    // Rich-text / markdown message
    await post(
      ana,
      eng,
      [
        '**Release checklist** for `auth-rotation`:',
        '',
        '- [x] tests green',
        '- [ ] changelog',
        '',
        '```bash',
        'npm run build && npm test',
        '```',
        '',
        'Docs: https://docs.rocket.chat/',
      ].join('\n'),
    );

    // Very long message (~3000 chars) -> output shaping under stress
    const longBody =
      'Postmortem draft (INC-118): ' +
      'The gateway returned elevated 5xx after the auth service redeploy. ' +
      'Root cause was a token-rotation race where in-flight requests held a ' +
      'stale signing key for a few hundred milliseconds during the rotation ' +
      'window. '.repeat(40);
    await post(diego, eng, longBody.slice(0, 3000));

    // Upload INSIDE a thread (mediaConfirm carries tmid)
    await uploadFile(
      bruno,
      eng,
      'gateway-latency.txt',
      'p50=12ms p95=210ms p99=980ms (pre-fix)\np50=11ms p95=80ms p99=140ms (post-fix)\n',
      'text/plain',
      'latency numbers for the migration thread',
      tLong._id,
    );
  } else {
    log('  #engineering already populated, skipping chatter');
  }

  // --- #incidents ---------------------------------------------------------
  if ((await roomMessageCount(incidents)) < 3) {
    const inc = incidents.rid;
    await post(diego, inc, 'INC-118 opened: elevated 5xx on the API gateway');
    await post(diego, inc, 'error rate at 4%, climbing. investigating upstream');
    await post(ana, inc, 'could be the auth service, it was redeployed an hour ago');
    await post(diego, inc, 'rolling back auth service to previous build');
    await post(bruno, inc, 'i can reproduce the 5xx hitting /login directly');
    // main-timeline @jean mention
    const incMention = await post(
      diego,
      inc,
      '@jean we may need your call on whether to declare a SEV2 — error rate still 3%',
    );
    report.incidents.mentionMsgId = incMention._id;
    await post(diego, inc, 'rollback complete, error rate dropping');
    await post(ana, inc, 'down to 0.2%, looks recovered');
    // @all broadcast
    await post(diego, inc, '@all incident INC-118 mitigated. postmortem doc to follow tomorrow.');
    await post(carla, inc, 'thanks everyone for the fast response');
  } else {
    log('  #incidents already populated, skipping chatter');
  }

  // --- #random ------------------------------------------------------------
  if ((await roomMessageCount(random)) < 3) {
    const rnd = random.rid;
    await post(ana, rnd, 'anyone tried the new ramen place near the office?');
    await post(bruno, rnd, 'yes! the tonkotsu is unreal');
    await post(carla, rnd, 'adding it to the team lunch list');
    const emojiMsg = await post(diego, rnd, 'friday mood 🎉🍜🚀😎🔥💯🎶🥳');
    await post(ana, rnd, 'who is up for board games after standup friday?');
    await post(bruno, rnd, 'count me in 🎲');
    await post(carla, rnd, 'i will bring snacks');
    await post(diego, rnd, 'catan rematch, i demand revenge');
    await post(ana, rnd, 'bold words for someone who lost last time');
    await post(bruno, rnd, 'cat tax: my cat sat on my keyboard during the deploy earlier 🐱');
    await post(carla, rnd, 'explains a lot honestly');
    const reactTarget = await post(diego, rnd, 'coffee machine on floor 3 is fixed, you are welcome');
    await post(ana, rnd, 'a true hero');
    await post(bruno, rnd, 'pizza order going in at 12, reply with toppings');
    await post(carla, rnd, 'pineapple (fight me)');
    // @here broadcast (we already have @all in #incidents)
    await post(diego, rnd, '@here standup moved to 9:30 tomorrow, dont be late');
    // reactions between personas
    await react(ana, emojiMsg._id, ':tada:');
    await react(bruno, emojiMsg._id, ':fire:');
    await react(carla, reactTarget._id, ':coffee:');
    await react(diego, reactTarget._id, ':raised_hands:');

    // A jean message that personas will react-to (custom emoji) + quote.
    const jeanMsg = await post(ADMIN, rnd, 'shipped the cli search command, give it a spin');
    report.random.quotedJeanMsgId = jeanMsg._id;
    if (await ensureCustomEmoji('rocketcli')) {
      // custom-emoji reaction on a jean message
      await react(ana, jeanMsg._id, ':rocketcli:');
      // a message that USES the custom emoji in text
      await post(bruno, rnd, 'nice work jean :rocketcli: trying it now');
    }
    // persona quotes jean's message (attachment with message_link)
    await postQuote(carla, rnd, jeanMsg._id, rnd, 'this is great — adding to the team wiki');
  } else {
    log('  #random already populated, skipping chatter');
  }

  // --- #leadership (private) ---------------------------------------------
  // count as carla (always a member) — robust even before jean's invite lands
  if ((await roomMessageCount(leadership, carla)) < 2) {
    const lead = leadership.rid;
    await post(carla, lead, 'planning sync — Q3 roadmap draft is ready for review');
    await post(carla, lead, 'top priorities: auth hardening, search perf, mobile parity');
    await post(carla, lead, 'headcount: we have budget for one more senior backend hire');
    const leadMention = await post(
      carla,
      lead,
      '@jean can you review the roadmap draft before the exec sync on friday?',
    );
    report.leadership.mentionMsgId = leadMention._id;
    await post(carla, lead, 'i moved the search-perf initiative ahead of mobile parity');
    await post(carla, lead, 'risk: the mobile contractor ramp is slower than planned');
    await post(carla, lead, 'proposing we lock scope at the friday sync');
    await post(carla, lead, 'agenda doc is in the shared drive, link in the calendar invite');
  } else {
    log('  #leadership already populated, skipping chatter');
  }

  // --- DMs to jean --------------------------------------------------------
  // ana -> jean, 3 messages
  const dmAna = await ensureDm(ana, 'jean');
  report.dmAnaId = dmAna;
  if ((await roomMessageCount({ rid: dmAna, name: 'dm-ana', type: 'd' })) < 1) {
    await post(ana, dmAna, 'hey jean — got a sec to talk through the rotation rollout plan?');
    await post(ana, dmAna, 'mainly want your read on the feature-flag staging approach');
    await post(ana, dmAna, 'no rush, tomorrow is fine. thanks!');
  }
  // diego -> jean, 2 messages
  const dmDiego = await ensureDm(diego, 'jean');
  report.dmDiegoId = dmDiego;
  if ((await roomMessageCount({ rid: dmDiego, name: 'dm-diego', type: 'd' })) < 1) {
    await post(diego, dmDiego, 'jean, the on-call rotation for next month needs your sign-off');
    await post(diego, dmDiego, 'sent the schedule to your inbox as well');
  }

  // --- file upload from bruno to #engineering ----------------------------
  // gate on whether an attachment already exists to keep it idempotent
  const engHist = await api<{ messages: any[] }>('GET', 'channels.history', {
    query: { roomId: engineering.rid, count: '50' },
  });
  const hasUpload = engHist.messages?.some((m) => Array.isArray(m.attachments) && m.attachments.length > 0 && m.file);
  if (!hasUpload) {
    await uploadFile(
      bruno,
      engineering.rid,
      'regression-report.txt',
      [
        'Regression pass — auth-rotation branch',
        '=======================================',
        'login flow:           PASS',
        'token rotation:       PASS',
        'session expiry:       PASS',
        'concurrent refresh:   PASS (after race fix)',
        '',
        'No blockers. Cleared for release.',
      ].join('\n'),
      'text/plain',
      'regression report for the auth-rotation branch — all green',
    );
    // Image upload (tiny PNG) with caption to #random
    await uploadFile(
      ana,
      random.rid,
      'team-mascot.png',
      TINY_PNG,
      'image/png',
      'our new team mascot (1px of pure spirit)',
    );
  }

  // Persona statuses (live data for get_user_profile)
  await setStatus(ana, 'busy', 'heads-down on auth rotation');
  await setStatus(diego, 'away', 'on-call — ping for incidents only');

  // Group DM: ana + bruno + jean (multi-member t='d')
  const groupDm = await ensureGroupDm(ana, ['bruno.qa', 'jean']);
  report.groupDmId = groupDm;
  if ((await roomMessageCount({ rid: groupDm, name: 'gdm', type: 'd' })) < 1) {
    await post(ana, groupDm, 'small group thread — release go/no-go for friday?');
    await post(bruno, groupDm, 'qa is green from my side');
    await post(ana, groupDm, 'jean, you have the final call on the go decision');
  }

  // --- NEGATIVE cases: must NOT surface for jean --------------------------
  // #secret-ops: jean is NOT a member. Contains the word "deploy" and an
  // @jean mention — none of it may leak into jean's rooms/unread/attention/
  // search. Created by diego; members are bruno + ana only.
  const secretOps = await ensureChannel('secret-ops', ['bruno.qa', 'ana.dev'], diego);
  report.secretOpsRid = secretOps.rid;
  // count as diego (a member) — jean (admin) intentionally cannot read it
  if ((await roomMessageCount(secretOps, diego)) < 2) {
    await post(diego, secretOps.rid, 'restricted: prod deploy keys rotation runbook');
    await post(ana, secretOps.rid, 'the deploy window is 02:00 UTC, do not announce widely');
    await post(diego, secretOps.rid, '@jean should NOT see this mention — membership boundary test');
    await post(bruno, secretOps.rid, 'deploy deploy deploy — search-leak canary token');
  }

  // Persona<->persona DM (ana -> bruno): must never surface for jean.
  const personaDm = await ensureDm(ana, 'bruno.qa');
  report.personaDmRid = personaDm;
  if ((await roomMessageCount({ rid: personaDm, name: 'ab', type: 'd' }, ana)) < 1) {
    await post(ana, personaDm, 'private: can you re-run the deploy smoke test before EOD?');
    await post(bruno, personaDm, 'on it, will ping when done');
  }

  return report;
  }); // end withSetting(rate limiter)

  // 4. Summary -------------------------------------------------------------
  printSummary(report);

  // credentials -> stderr only
  process.stderr.write('\n');
  process.stderr.write('=== SEED CREDENTIALS (stderr only — not in stdout) ===\n');
  process.stderr.write(`shared persona password: ${creds.password}\n`);
  process.stderr.write(`credentials file:        ${CRED_PATH}\n`);
  process.stderr.write('=======================================================\n');
}

function printSummary(r: SeedReport): void {
  const out = (s: string) => process.stdout.write(s + '\n');
  out('');
  out('=== Seeded workspace summary ===');
  out('');
  out('Personas (username):');
  for (const p of PERSONAS) out(`  - ${p.username.padEnd(10)}  ${p.name}`);
  out('');
  out('Rooms and what they hold FOR JEAN:');
  const rows: Array<[string, string, string]> = [
    ['#engineering (c)', r.engineering.rid, 'unread; thread w/ @jean reply; 2nd thread'],
    ['#incidents (c)', r.incidents.rid, 'unread; @jean mention + @all broadcast'],
    ['#random (c)', r.random.rid, 'unread; emoji msg; reactions'],
    ['#leadership (p)', r.leadership.rid, 'unread; @jean mention (private group)'],
    ['DM ana.dev->jean', r.dmAnaId ?? '?', 'unread DM (3 msgs)'],
    ['DM diego.ops->jean', r.dmDiegoId ?? '?', 'unread DM (2 msgs)'],
  ];
  const w0 = Math.max(...rows.map((x) => x[0].length));
  const w1 = Math.max(...rows.map((x) => x[1].length));
  out(`  ${'ROOM'.padEnd(w0)}  ${'RID'.padEnd(w1)}  STATE FOR JEAN`);
  for (const [name, rid, state] of rows) {
    out(`  ${name.padEnd(w0)}  ${rid.padEnd(w1)}  ${state}`);
  }
  out('');
  out('Key ids for the true-usage test:');
  out(`  engineering rid:        ${r.engineering.rid}`);
  if (r.engineering.mentionThreadId)
    out(`  ana deploy thread tmid: ${r.engineering.mentionThreadId}`);
  if (r.engineering.mentionMsgId)
    out(`  @jean thread reply id:  ${r.engineering.mentionMsgId}`);
  if (r.incidents.mentionMsgId)
    out(`  @jean #incidents msg:   ${r.incidents.mentionMsgId}`);
  if (r.leadership.mentionMsgId)
    out(`  @jean #leadership msg:  ${r.leadership.mentionMsgId}`);
  out('');
  out('Expected mentions for jean: thread reply + #incidents + #leadership (3).');
  out('Expected unread rooms: #engineering, #incidents, #random, #leadership, 2 DMs.');
}

main().catch((err) => {
  process.stderr.write(`\nSEED FAILED: ${err?.stack ?? err}\n`);
  process.exit(1);
});
