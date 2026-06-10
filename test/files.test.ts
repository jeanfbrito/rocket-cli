import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadFile, uploadFile, type FilesConfig } from '../src/core/files.js';

const CFG: FilesConfig = {
  url: 'https://chat.example.com',
  token: 'tok-123',
  userId: 'usr-456',
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'rc-files-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

// ---- upload ---------------------------------------------------------------

describe('uploadFile', () => {
  it('performs the two-step media -> mediaConfirm sequence with auth + multipart', async () => {
    const filePath = join(tmp, 'note.txt');
    writeFileSync(filePath, 'hello bytes');

    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/rooms.media/')) {
        return new Response(JSON.stringify({ success: true, file: { _id: 'file-789' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // mediaConfirm
      return new Response(
        JSON.stringify({ success: true, message: { _id: 'msg-1', rid: 'RID1', msg: 'cap' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { message } = await uploadFile(CFG, {
      rid: 'RID1',
      filePath,
      text: 'cap',
      threadId: 'parent-9',
    });

    expect(message._id).toBe('msg-1');
    expect(calls).toHaveLength(2);

    // Step 1: media endpoint + auth headers + multipart file field.
    const [media, confirm] = calls;
    expect(media!.url).toBe('https://chat.example.com/api/v1/rooms.media/RID1');
    const mediaHeaders = media!.init.headers as Record<string, string>;
    expect(mediaHeaders['X-Auth-Token']).toBe('tok-123');
    expect(mediaHeaders['X-User-Id']).toBe('usr-456');
    expect(media!.init.body).toBeInstanceOf(FormData);
    const form = media!.init.body as FormData;
    const fileField = form.get('file');
    expect(fileField).toBeInstanceOf(Blob);
    expect((fileField as File).name).toBe('note.txt');

    // Step 2: mediaConfirm endpoint with fileId; body carries msg + tmid.
    expect(confirm!.url).toBe(
      'https://chat.example.com/api/v1/rooms.mediaConfirm/RID1/file-789',
    );
    const confirmBody = JSON.parse(confirm!.init.body as string) as Record<string, string>;
    expect(confirmBody.msg).toBe('cap');
    expect(confirmBody.tmid).toBe('parent-9');
  });

  it('infers content-type from the file extension', async () => {
    const filePath = join(tmp, 'pic.png');
    writeFileSync(filePath, 'png-bytes');

    let mediaForm: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit) => {
        if (String(url).includes('/rooms.media/')) {
          mediaForm = init.body as FormData;
          return new Response(JSON.stringify({ file: { _id: 'f1' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: { _id: 'm1' } }), { status: 200 });
      }),
    );

    await uploadFile(CFG, { rid: 'R', filePath });
    const blob = mediaForm!.get('file') as Blob;
    expect(blob.type).toBe('image/png');
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const filePath = join(tmp, 'data.xyz');
    writeFileSync(filePath, 'bytes');

    let mediaForm: FormData | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit) => {
        if (String(url).includes('/rooms.media/')) {
          mediaForm = init.body as FormData;
          return new Response(JSON.stringify({ file: { _id: 'f1' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: {} }), { status: 200 });
      }),
    );

    await uploadFile(CFG, { rid: 'R', filePath });
    expect((mediaForm!.get('file') as Blob).type).toBe('application/octet-stream');
  });

  it('rejects a missing file before hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      uploadFile(CFG, { rid: 'R', filePath: join(tmp, 'nope.txt') }),
    ).rejects.toThrow(/File not found/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a non-2xx media response through mapRcError', async () => {
    const filePath = join(tmp, 'a.txt');
    writeFileSync(filePath, 'x');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'no access', errorType: 'error-not-allowed' }), {
            status: 403,
          }),
      ),
    );
    await expect(uploadFile(CFG, { rid: 'R', filePath })).rejects.toThrow(/Permission denied/);
  });
});

// ---- download -------------------------------------------------------------

describe('downloadFile', () => {
  function okStream(bytes: string, contentType = 'application/octet-stream'): Response {
    return new Response(bytes, { status: 200, headers: { 'content-type': contentType } });
  }

  it('writes a file from a /file-upload path with auth headers', async () => {
    let seenHeaders: Record<string, string> = {};
    let seenUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init: RequestInit) => {
        seenUrl = String(url);
        seenHeaders = init.headers as Record<string, string>;
        return okStream('the-contents', 'text/plain');
      }),
    );

    const out = join(tmp, 'got.txt');
    const res = await downloadFile(CFG, {
      fileUrl: '/file-upload/abc/got.txt',
      savePath: out,
    });

    expect(seenUrl).toBe('https://chat.example.com/file-upload/abc/got.txt');
    expect(seenHeaders['x-auth-token']).toBe('tok-123');
    expect(seenHeaders['x-user-id']).toBe('usr-456');
    expect(res.path).toBe(out);
    expect(res.bytes).toBe(Buffer.byteLength('the-contents'));
    expect(res.contentType).toBe('text/plain');
    expect(readFileSync(out, 'utf8')).toBe('the-contents');
  });

  it('sanitizes a traversal filename derived from the URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okStream('safe')));
    // savePath omitted -> derive from URL basename, but force into tmp via HOME.
    const prevHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    try {
      const res = await downloadFile(CFG, {
        fileUrl: '/file-upload/abc/..%2Fevil',
      });
      // basename of the path is the last segment; '..' and separators stripped.
      expect(res.path.includes('..')).toBe(false);
      expect(res.path.startsWith(join(tmp, 'Downloads'))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
    }
  });

  it('never overwrites: suffixes -1, -2 ...', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okStream('v2')));
    const existing = join(tmp, 'dup.txt');
    writeFileSync(existing, 'v1');

    const res = await downloadFile(CFG, { fileUrl: '/file-upload/x/dup.txt', savePath: existing });
    expect(res.path).toBe(join(tmp, 'dup-1.txt'));
    expect(existsSync(existing)).toBe(true);
    expect(readFileSync(existing, 'utf8')).toBe('v1'); // original untouched
    expect(readFileSync(res.path, 'utf8')).toBe('v2');
  });

  it('rejects a cross-origin download', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      downloadFile(CFG, { fileUrl: 'https://evil.example.org/file-upload/x/y' }),
    ).rejects.toThrow(/cross-origin/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a non-2xx download response through mapRcError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );
    await expect(
      downloadFile(CFG, { fileUrl: '/file-upload/x/y', savePath: join(tmp, 'z') }),
    ).rejects.toThrow(/Authentication failed/);
  });
});
