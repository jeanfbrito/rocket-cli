#!/usr/bin/env tsx
/**
 * Automated true-usage test for rocket-cli.
 *
 * Runs the built CLI (`node dist/cli.js ... --json`) against a freshly-seeded
 * server, with a temp SQLite cache so it starts from a cold, fully-synced
 * state — then ASSERTS the seeded state surfaces correctly through every
 * read-path feature: attention, unread, mentions, search, thread, open.
 *
 * Pair with scripts/seed.ts:
 *   npm run seed        # create the multi-user state
 *   npm run validate    # assert the CLI sees it
 *   npm run validate:full   # both, back to back
 *
 * Exits 0 only when every assertion passes; exits 1 on any failure.
 *
 * Resilient to re-runs: the seeder is idempotent and counts only grow, so all
 * assertions use >= / contains, never strict equality on volatile counts.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CLI = join(REPO_ROOT, 'dist', 'cli.js');

// Isolated cache so we exercise a cold sync, never the user's real cache.
const TMP_DB = join(mkdtempSync(join(tmpdir(), 'rocket-cli-validate-')), 'cache.db');

const cfg = loadConfig();

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  const res = spawnSync('node', [CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ROCKET_CLI_DB: TMP_DB },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function runJson<T = any>(args: string[]): T {
  const r = runCli([...args, '--json']);
  if (r.status !== 0) {
    throw new Error(`CLI ${args.join(' ')} exited ${r.status}: ${r.stderr.slice(0, 300)}`);
  }
  // The JSON report is the last non-empty stdout line (some commands emit
  // progress to stderr; --json writes a single JSON line to stdout).
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new Error(`CLI ${args.join(' ')} did not emit JSON: ${r.stdout.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const lines: string[] = [];

function check(label: string, ok: boolean, detail = ''): boolean {
  if (ok) {
    passed++;
    lines.push(`  PASS  ${label}`);
  } else {
    failed++;
    lines.push(`  FAIL  ${label}${detail ? `  — ${detail}` : ''}`);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Report shapes (mirrors of src/core/*.ts, only the fields we read)
// ---------------------------------------------------------------------------

interface CompactMessage {
  id: string;
  author: string;
  text: string;
  time: string;
  threadId?: string;
  edited?: true;
  attachments?: string[];
  link?: string;
}
interface RoomRef {
  id: string;
  name: string;
  type: 'channel' | 'group' | 'dm';
}
interface AttentionItem {
  room: RoomRef;
  message: CompactMessage;
}
interface AttentionThread {
  room: RoomRef;
  parent: CompactMessage;
  messages: CompactMessage[];
}
interface AttentionReport {
  mentions: AttentionItem[];
  directUnreads: AttentionItem[];
  threadUnreads: AttentionThread[];
  channelUnreads: AttentionItem[];
  totals: { mentions: number; directUnreads: number; threadUnreads: number; channelUnreads: number; all: number };
}
interface UnreadRoom {
  room: { id: string; name: string; type: string };
  unreadCount: number;
  activityOnly: boolean;
  messages: CompactMessage[];
  unreadThreads: { parent: CompactMessage; messages: CompactMessage[] }[];
}
interface UnreadReport {
  rooms: UnreadRoom[];
  totals: { rooms: number; messages: number; threads: number };
}
interface MentionRoom {
  room: { id: string; name: string; type: string };
  messages: CompactMessage[];
}
interface MentionsReport {
  mentions: MentionRoom[];
  totals: { rooms: number; messages: number };
}
interface SearchHit extends CompactMessage {
  roomId: string;
  source: string;
  snippet?: string;
}
interface SearchResult {
  results: SearchHit[];
}
interface ThreadResult {
  parent: CompactMessage;
  messages: CompactMessage[];
}
interface OpenResult {
  messages: CompactMessage[];
  target?: CompactMessage;
}

// Names the seeder creates.
const SEEDED_ROOMS = ['engineering', 'incidents', 'random', 'leadership'];
const SECRET_ROOM = 'secret-ops';

function roomNames(report: { mentions?: any[]; rooms?: any[] }): string[] {
  const out: string[] = [];
  const src = report.rooms ?? report.mentions ?? [];
  for (const r of src) out.push(r.room?.name ?? '');
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  if (!existsSync(CLI)) {
    process.stderr.write(`CLI not built: ${CLI}\nRun \`npm run build\` first.\n`);
    process.exit(1);
  }

  lines.push('=== rocket-cli true-usage validation ===');
  lines.push(`server:  ${cfg.url}`);
  lines.push(`cache:   ${TMP_DB} (isolated)`);
  lines.push('');

  // --- cold sync: pull all subscribed rooms into the temp cache -----------
  lines.push('Syncing all rooms into the isolated cache...');
  const sync = runCli(['sync', '--all']);
  check('sync --all completes', sync.status === 0, sync.stderr.slice(0, 200));
  lines.push('');

  // --- attention ----------------------------------------------------------
  lines.push('[attention --since-days 1 --all-broadcasts]');
  const att = runJson<AttentionReport>(['attention', '--since-days', '1', '--all-broadcasts', '--limit', '100']);
  const attMentionRooms = att.mentions.map((m) => m.room.name);
  check('attention surfaces >= 1 mention', att.mentions.length >= 1, `got ${att.mentions.length}`);
  check(
    'attention mention from #incidents present',
    attMentionRooms.includes('incidents'),
    attMentionRooms.join(','),
  );
  check(
    'attention mention from #leadership (private) present',
    attMentionRooms.includes('leadership'),
    attMentionRooms.join(','),
  );
  check(
    'attention mention from a thread reply present (engineering)',
    att.mentions.some((m) => m.room.name === 'engineering'),
    attMentionRooms.join(','),
  );
  check('attention surfaces DM unreads (>=1)', att.directUnreads.length >= 1, `got ${att.directUnreads.length}`);
  const dmAuthors = att.directUnreads.map((d) => d.message.author);
  check(
    'attention DM unread from ana.dev or diego.ops',
    dmAuthors.includes('ana.dev') || dmAuthors.includes('diego.ops'),
    dmAuthors.join(','),
  );
  check(
    'attention surfaces an unread thread (threadUnreads >=1)',
    att.threadUnreads.length >= 1,
    `got ${att.threadUnreads.length}`,
  );
  check(
    'attention surfaces unread channels (>=1)',
    att.channelUnreads.length >= 1,
    `got ${att.channelUnreads.length}`,
  );
  // NEGATIVE: secret-ops must never appear in any attention section.
  const allAttRooms = [
    ...att.mentions,
    ...att.directUnreads,
    ...att.channelUnreads,
  ].map((i) => i.room.name).concat(att.threadUnreads.map((t) => t.room.name));
  check(
    'NEGATIVE attention excludes #secret-ops (membership boundary)',
    !allAttRooms.includes(SECRET_ROOM),
    allAttRooms.join(','),
  );
  lines.push('');

  // --- unread -------------------------------------------------------------
  lines.push('[unread]');
  const unread = runJson<UnreadReport>(['unread', '--limit', '100']);
  const unreadRooms = roomNames(unread);
  for (const name of SEEDED_ROOMS) {
    check(`unread lists #${name}`, unreadRooms.includes(name), unreadRooms.join(','));
  }
  // Sidebar-parity (schema v6 alert column): on a default-config server
  // (Unread_Count = user_and_group_mentions_only) a plain-chatter channel like
  // #random — persona messages with NO @jean mention — has subscription
  // alert:true but unread:0. collectUnread must still surface it (predicate
  // alert || unread || tunread), flagging activityOnly:true with messages
  // sliced by `ls`. On a server with Unread_Count = all_messages it carries a
  // real count instead. The invariant is PRESENCE in the list; activityOnly is
  // conditional on the server's Unread_Count setting.
  const randomRoom = unread.rooms.find((r) => r.room.name === 'random');
  check(
    'sidebar-parity: #random present in unread despite no @jean mention',
    !!randomRoom,
    'random missing from unread list',
  );
  if (randomRoom) {
    check(
      'sidebar-parity: #random surfaces messages (real count OR activityOnly)',
      randomRoom.messages.length > 0 &&
        (randomRoom.activityOnly === true || randomRoom.unreadCount > 0),
      `count=${randomRoom.unreadCount} activityOnly=${randomRoom.activityOnly} msgs=${randomRoom.messages.length}`,
    );
  }
  check(
    'NEGATIVE unread excludes #secret-ops',
    !unreadRooms.includes(SECRET_ROOM),
    unreadRooms.join(','),
  );
  lines.push('');

  // --- mentions -----------------------------------------------------------
  lines.push('[mentions --since-days 1]');
  const mentions = runJson<MentionsReport>(['mentions', '--since-days', '1', '--limit', '100']);
  check(
    'mentions finds >= 3 across rooms',
    mentions.totals.messages >= 3,
    `got ${mentions.totals.messages}`,
  );
  const mentionRooms = mentions.mentions.map((m) => m.room.name);
  check(
    'mentions include #incidents + #leadership + engineering',
    ['incidents', 'leadership', 'engineering'].every((n) => mentionRooms.includes(n)),
    mentionRooms.join(','),
  );
  const allMentionMsgs = mentions.mentions.flatMap((r) => r.messages);
  check(
    'mention messages carry deep-links',
    allMentionMsgs.length > 0 && allMentionMsgs.every((m) => typeof m.link === 'string' && m.link.length > 0),
    'some mention missing link',
  );
  check(
    'NEGATIVE mentions exclude #secret-ops mention',
    !mentionRooms.includes(SECRET_ROOM),
    mentionRooms.join(','),
  );
  lines.push('');

  // --- search -------------------------------------------------------------
  lines.push('[search "deploy"]');
  const search = runJson<SearchResult>(['search', 'deploy', '--limit', '100']);
  check('search "deploy" returns hits', search.results.length >= 1, `got ${search.results.length}`);
  const searchText = search.results.map((h) => `${h.text} ${h.snippet ?? ''}`).join('\n').toLowerCase();
  check(
    'search hits include the deploy-pipeline thread content',
    searchText.includes('deploy pipeline') || searchText.includes('pipeline'),
    'thread text not found in results',
  );
  // NEGATIVE: the secret-ops "deploy deploy deploy" canary must not leak.
  const searchRids = new Set(search.results.map((h) => h.roomId));
  // resolve secret-ops rid via the report we cannot see -> assert by canary text instead.
  check(
    'NEGATIVE search excludes #secret-ops canary token',
    !searchText.includes('search-leak canary'),
    'secret-ops canary leaked into search',
  );
  void searchRids;
  lines.push('');

  // --- thread (find the long thread id, read it fully) --------------------
  lines.push('[thread <long-thread-id>]');
  // Discover the long migration thread: list threads in #engineering, pick the
  // one with the most replies (the 32-reply migration notes thread).
  const threadsList = runJson<{ id?: string; text?: string; replyCount?: number }[]>(
    ['threads', 'engineering', '-n', '50'],
  );
  let longThreadId: string | undefined;
  let bestCount = -1;
  for (const t of threadsList) {
    const rc = t.replyCount ?? 0;
    if (rc > bestCount) {
      bestCount = rc;
      longThreadId = t.id;
    }
  }
  check('found a thread to read in #engineering', !!longThreadId, JSON.stringify(threadsList).slice(0, 200));
  if (longThreadId) {
    const thread = runJson<ThreadResult>(['thread', longThreadId, '-n', '100']);
    check(
      'long thread reads >= 30 replies fully',
      thread.messages.length >= 30,
      `got ${thread.messages.length}`,
    );
  }
  lines.push('');

  // --- edited & deleted (verify via timeline/open + search) ---------------
  lines.push('[edited / deleted message]');
  // Edited: the corrected standup message must be present with new text.
  const engSearchEdited = runJson<SearchResult>(['search', 'corrected', '--room', 'engineering', '--limit', '50']);
  check(
    'edited message reflects corrected text',
    engSearchEdited.results.some((h) => h.text.includes('9:30am') || h.text.toLowerCase().includes('corrected')),
    'edited text not found',
  );
  // Deleted: the doomed "accidental paste" message must be gone from search.
  const engSearchDeleted = runJson<SearchResult>(['search', 'accidental paste', '--room', 'engineering', '--limit', '50']);
  check(
    'deleted message absent from search after sync',
    !engSearchDeleted.results.some((h) => h.text.includes('accidental paste')),
    'deleted message still searchable',
  );
  lines.push('');

  // --- custom emoji does not break parsing --------------------------------
  lines.push('[custom emoji :rocketcli:]');
  const randSearch = runJson<SearchResult>(['search', 'rocketcli', '--room', 'random', '--limit', '50']);
  check(
    'message using :rocketcli: parses and is searchable',
    randSearch.results.some((h) => h.text.includes(':rocketcli:')),
    'rocketcli text message not found (non-fatal if reaction-only)',
  );
  lines.push('');

  // --- open a permalink (use a mention message link) ----------------------
  lines.push('[open <permalink>]');
  const aMention = allMentionMsgs.find((m) => m.link);
  if (check('have a mention permalink to open', !!aMention?.link, 'no mention link available') && aMention?.link) {
    const opened = runJson<OpenResult>(['open', aMention.link, '-n', '20']);
    check('open resolves the permalink to messages', opened.messages.length >= 1, `got ${opened.messages.length}`);
    check(
      'open marks the target message',
      !!opened.target && opened.target.id === aMention.id,
      `target ${opened.target?.id} vs ${aMention.id}`,
    );
    // affordance: human (non-json) output prints a reply/react footer.
    const humanOpen = runCli(['open', aMention.link, '-n', '20']);
    check(
      'open (human) prints a reply/react affordance footer',
      /reply:\s+rocket-cli send/.test(humanOpen.stdout),
      'no affordance footer',
    );
  }
  lines.push('');

  // --- NEGATIVE: persona<->persona DM never surfaces for jean -------------
  // ana->bruno DM content ("re-run the deploy smoke test") must not appear in
  // jean's search/attention/unread. We assert on its unique phrase.
  lines.push('[NEGATIVE persona<->persona DM]');
  const leakSearch = runJson<SearchResult>(['search', 'smoke test before EOD', '--limit', '50']);
  check(
    'NEGATIVE persona<->persona DM content absent from jean search',
    leakSearch.results.length === 0,
    `leaked ${leakSearch.results.length} hits`,
  );
  lines.push('');

  // --- summary ------------------------------------------------------------
  lines.push('=== summary ===');
  lines.push(`  ${passed} passed, ${failed} failed`);
  process.stdout.write(lines.join('\n') + '\n');

  process.exit(failed === 0 ? 0 : 1);
}

try {
  main();
} catch (err: any) {
  process.stdout.write(lines.join('\n') + '\n');
  process.stderr.write(`\nVALIDATION ERROR: ${err?.stack ?? err}\n`);
  process.exit(1);
}
