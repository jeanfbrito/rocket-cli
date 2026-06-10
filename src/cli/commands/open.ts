import type { Command } from 'commander';
import { withApp, printTable } from './util.js';
import { rowToCompactWithLink } from '../../core/normalize.js';
import type { App } from '../../core/app.js';
import type { MessageRow, RoomRow } from '../../core/types.js';
import { messageToRow } from '../../core/normalize.js';
import { looksLikeUrl, parseRocketChatUrl } from '../../core/urls.js';

/**
 * `rocket-cli open <url>` — the human-facing twin of the open_url MCP tool.
 * Paste any Rocket.Chat web link (message, thread, or channel) and get its
 * content in chronological order, with the target message marked `→ ` and a
 * footer telling you how to reply. `--json` emits compact records.
 */
export function register(program: Command): void {
  program
    .command('open <url>')
    .description('Open a pasted Rocket.Chat link (message, thread, or channel)')
    .option('-n, --count <n>', 'number of messages of context to show', '20')
    .option('--json', 'output as compact JSON records')
    .action(
      async (url: string, opts: { count: string; json?: boolean }, command: Command) => {
        await withApp(async (app) => {
          const count = Math.max(1, parseInt(opts.count, 10) || 20);
          const json = command.optsWithGlobals<{ json?: boolean }>().json;

          if (!looksLikeUrl(url)) {
            throw new Error(
              `Expected a Rocket.Chat web link, got "${url}". ` +
                `Example: ${app.config.url}/channel/general?msg=<id>`,
            );
          }
          const parsed = parseRocketChatUrl(app.config.url, url);
          if (!parsed) {
            throw new Error(
              `URL is not a Rocket.Chat link on ${app.config.url}.`,
            );
          }

          const room = await app.rooms.resolve(parsed.roomRef);
          const roomName = room.name ?? room.fname ?? room.rid;

          if (parsed.messageId !== undefined) {
            await openMessage(app, room, roomName, parsed.messageId, count, json);
          } else {
            await openRoom(app, room, roomName, count, json);
          }
        });
      },
    );
}

async function fetchMessage(
  app: App,
  room: RoomRow,
  messageId: string,
): Promise<MessageRow | null> {
  const local = app.db.getMessage(messageId);
  if (local) return local;
  const res = await app.rc.getMessage({ msgId: messageId });
  if (!res.message || !res.message._id) return null;
  const rid = res.message.rid ?? room.rid;
  const row = messageToRow(res.message, rid);
  app.db.upsertMessages([row]);
  return row;
}

async function openMessage(
  app: App,
  room: RoomRow,
  roomName: string,
  messageId: string,
  count: number,
  json: boolean | undefined,
): Promise<void> {
  await app.sync.ensureRoomSynced(room.rid);
  let target = await fetchMessage(app, room, messageId);
  if (!target) {
    throw new Error(`Message "${messageId}" not found in ${roomName}.`);
  }

  const threadParentId =
    target.tmid != null && target.tmid !== ''
      ? target.tmid
      : (target.tcount ?? 0) > 0
        ? target.id
        : null;

  if (threadParentId !== null) {
    const parent = await app.sync.ensureThreadLoaded(threadParentId);
    const replies = app.db.getThreadMessages(threadParentId, { limit: count });
    target = app.db.getMessage(messageId) ?? target;
    const rows = [parent, ...replies];
    if (json) {
      emitJson(app, room, rows, target);
      return;
    }
    printMessages(rows, target.id);
    process.stdout.write(footerReply(threadParentId) + '\n');
    return;
  }

  const half = Math.max(1, Math.floor(count / 2));
  const older = app.db.getTimeline(room.rid, { limit: half, beforeTs: target.ts });
  const newer = app.db.getTimeline(room.rid, { limit: half, afterTs: target.ts });
  const rows = [...[...older].reverse(), target, ...[...newer].reverse()];
  if (json) {
    emitJson(app, room, rows, target);
    return;
  }
  printMessages(rows, target.id);
  process.stdout.write(footerReact(roomName) + '\n');
}

async function openRoom(
  app: App,
  room: RoomRow,
  roomName: string,
  count: number,
  json: boolean | undefined,
): Promise<void> {
  await app.sync.ensureRoomSynced(room.rid);
  const rows = [...app.db.getTimeline(room.rid, { limit: count })].reverse();
  if (json) {
    emitJson(app, room, rows);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write('No messages found.\n');
    return;
  }
  printMessages(rows, null);
  process.stdout.write(footerSend(roomName) + '\n');
}

function emitJson(
  app: App,
  room: RoomRow,
  rows: MessageRow[],
  target?: MessageRow,
): void {
  const compact = rows.map((r) => rowToCompactWithLink(r, room, app.config.url));
  const payload: Record<string, unknown> = { messages: compact };
  if (target) {
    payload['target'] = rowToCompactWithLink(target, room, app.config.url);
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
}

/** Print messages as an aligned table, marking the target row with `→ `. */
function printMessages(rows: MessageRow[], targetId: string | null): void {
  const tableRows: string[][] = [];
  for (const r of rows) {
    const marker = targetId != null && r.id === targetId ? '→ ' : '  ';
    const time = r.ts
      ? new Date(r.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      : '??:??';
    const author = r.author_username ?? r.author_name ?? r.author_id ?? '?';
    let text = r.text;
    if (r.tcount && r.tcount > 0) {
      text += `  (${r.tcount} ${r.tcount === 1 ? 'reply' : 'replies'}, id: ${r.id})`;
    }
    tableRows.push([`${marker}[${time}]`, `@${author}:`, text]);
  }
  printTable(tableRows);
}

function footerReply(tmid: string): string {
  return `\nreply: rocket-cli send <room> "<text>" --thread ${tmid}`;
}

function footerReact(roomName: string): string {
  return `\nreply: rocket-cli send ${roomName} "<text>"`;
}

function footerSend(roomName: string): string {
  return `\nreply: rocket-cli send ${roomName} "<text>"`;
}
