import { describe, expect, it } from 'vitest';
import {
  type RcWireAttachment,
  type RcWireMessage,
  type RcWireSubscription,
  messageToRow,
  rowToCompact,
  subscriptionToRoomRow,
  toIso,
} from '../src/core/normalize.js';

const RID = 'GENERAL';
const TS = '2026-06-10T14:02:11.000Z';

// Fixtures are annotated with the official-types-derived wire shapes so that
// any drift between our normalizer inputs and `@rocket.chat/core-typings`
// surfaces at compile time.
function plain(overrides: Partial<RcWireMessage> = {}): RcWireMessage {
  return {
    _id: 'm1',
    rid: RID,
    msg: 'hello world',
    ts: TS,
    u: { _id: 'u1', username: 'jean', name: 'Jean Brito' },
    _updatedAt: TS,
    ...overrides,
  } satisfies RcWireMessage;
}

describe('toIso date guard', () => {
  it('passes ISO strings through (normalized)', () => {
    expect(toIso(TS)).toBe(TS);
  });
  it('converts { $date: number } form', () => {
    const ms = Date.parse(TS);
    expect(toIso({ $date: ms })).toBe(TS);
  });
  it('converts raw epoch numbers', () => {
    const ms = Date.parse(TS);
    expect(toIso(ms)).toBe(TS);
  });
  it('null/undefined -> null', () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(undefined)).toBeNull();
  });
});

describe('messageToRow', () => {
  it('maps a plain message', () => {
    const row = messageToRow(plain(), RID);
    expect(row).toMatchObject({
      id: 'm1',
      rid: RID,
      author_id: 'u1',
      author_username: 'jean',
      author_name: 'Jean Brito',
      text: 'hello world',
      ts: TS,
      tmid: null,
      tcount: null,
      tlm: null,
      edited_at: null,
      system_type: null,
      attachments_json: null,
      deleted: 0,
      updated_at: TS,
    });
  });

  it('maps an edited message', () => {
    const row = messageToRow(plain({ editedAt: TS }), RID);
    expect(row.edited_at).toBe(TS);
  });

  it('maps a thread parent (tcount / tlm)', () => {
    const tlm = '2026-06-10T15:00:00.000Z';
    const row = messageToRow(plain({ tcount: 4, tlm }), RID);
    expect(row.tcount).toBe(4);
    expect(row.tlm).toBe(tlm);
    expect(row.tmid).toBeNull();
  });

  it('maps a thread reply (tmid)', () => {
    const row = messageToRow(plain({ _id: 'm2', tmid: 'm1' }), RID);
    expect(row.tmid).toBe('m1');
    expect(row.tcount).toBeNull();
  });

  it('maps an attachment-only message (empty msg + file attachment)', () => {
    const row = messageToRow(
      plain({
        msg: '',
        attachments: [
          { title: 'report.pdf', title_link: '/file/report.pdf' } satisfies RcWireAttachment,
        ],
      }),
      RID,
    );
    expect(row.text).toBe('');
    const lines = JSON.parse(row.attachments_json!) as string[];
    // File attachments carry their download link as `<label> -> <link>`.
    expect(lines).toEqual(['[file] report.pdf -> /file/report.pdf']);
  });

  it('maps image / video / audio / quote / plain attachments to one-liners', () => {
    const row = messageToRow(
      plain({
        attachments: [
          { title: 'pic.png', image_url: '/img/pic.png' },
          { title: 'clip.mp4', video_url: '/vid/clip.mp4' },
          { title: 'song.mp3', audio_url: '/aud/song.mp3' },
          { message_link: '/msg/x', text: 'a'.repeat(120) },
          { text: 'just some text' },
        ] satisfies RcWireAttachment[],
      }),
      RID,
    );
    const lines = JSON.parse(row.attachments_json!) as string[];
    // Downloadable media include the link after ' -> '.
    expect(lines[0]).toBe('[image] pic.png -> /img/pic.png');
    expect(lines[1]).toBe('[video] clip.mp4 -> /vid/clip.mp4');
    expect(lines[2]).toBe('[audio] song.mp3 -> /aud/song.mp3');
    // Quotes link back to a message, not a download — no link suffix.
    expect(lines[3]).toBe(`[quote] ${'a'.repeat(80)}`);
    expect(lines[4]).toBe('just some text');
  });

  it('maps a system message (t: uj)', () => {
    const row = messageToRow(plain({ msg: '', t: 'uj' }), RID);
    expect(row.system_type).toBe('uj');
  });

  it('handles { $date } ts variant', () => {
    const ms = Date.parse(TS);
    const row = messageToRow(plain({ ts: { $date: ms } }), RID);
    expect(row.ts).toBe(TS);
  });
});

describe('rowToCompact', () => {
  it('omits null / empty fields for a plain message', () => {
    const compact = rowToCompact(messageToRow(plain(), RID));
    expect(compact).toEqual({
      id: 'm1',
      author: 'jean',
      text: 'hello world',
      time: TS,
    });
    expect('threadId' in compact).toBe(false);
    expect('replyCount' in compact).toBe(false);
    expect('edited' in compact).toBe(false);
    expect('system' in compact).toBe(false);
    expect('attachments' in compact).toBe(false);
  });

  it('includes thread parent fields', () => {
    const tlm = '2026-06-10T15:00:00.000Z';
    const compact = rowToCompact(messageToRow(plain({ tcount: 3, tlm }), RID));
    expect(compact.replyCount).toBe(3);
    expect(compact.lastReplyAt).toBe(tlm);
  });

  it('includes threadId for a reply', () => {
    const compact = rowToCompact(messageToRow(plain({ tmid: 'm1' }), RID));
    expect(compact.threadId).toBe('m1');
  });

  it('marks edited messages', () => {
    const compact = rowToCompact(messageToRow(plain({ editedAt: TS }), RID));
    expect(compact.edited).toBe(true);
  });

  it('surfaces system type and attachments', () => {
    const compact = rowToCompact(
      messageToRow(
        plain({
          t: 'uj',
          attachments: [{ title: 'f.txt', title_link: '/f' } satisfies RcWireAttachment],
        }),
        RID,
      ),
    );
    expect(compact.system).toBe('uj');
    expect(compact.attachments).toEqual(['[file] f.txt -> /f']);
  });
});

describe('subscriptionToRoomRow', () => {
  it('maps rid/name/fname/t/unread and sub_updated_at from _updatedAt', () => {
    const row = subscriptionToRoomRow({
      rid: RID,
      name: 'general',
      fname: 'General',
      t: 'c',
      unread: 5,
      _updatedAt: TS,
    } satisfies RcWireSubscription);
    expect(row).toEqual({
      rid: RID,
      name: 'general',
      fname: 'General',
      t: 'c',
      unread: 5,
      sub_updated_at: TS,
    });
  });

  it('defaults unread to 0 and missing dates to null', () => {
    const row = subscriptionToRoomRow({ rid: RID, t: 'd' } satisfies RcWireSubscription);
    expect(row.unread).toBe(0);
    expect(row.sub_updated_at).toBeNull();
    expect(row.name).toBeNull();
  });
});
