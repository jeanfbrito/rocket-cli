import { describe, expect, it } from 'vitest';
import { RateLimitError, RcApiError, mapRcError } from '../src/core/errors.js';

const CTX = 'GET /v1/subscriptions.get @ https://chat.example.com';

describe('mapRcError', () => {
  it('401 -> RcApiError with PAT / 2FA auth hint', async () => {
    const res = new Response(JSON.stringify({ error: 'unauthorized', errorType: 'error-unauthorized' }), {
      status: 401,
    });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RcApiError);
    const api = err as RcApiError;
    expect(api.status).toBe(401);
    expect(api.errorType).toBe('error-unauthorized');
    expect(api.message).toContain('ROCKETCHAT_TOKEN');
    expect(api.message).toContain('Ignore Two Factor Authentication');
  });

  it('429 with Retry-After header -> RateLimitError with retryAfterMs', async () => {
    const res = new Response(JSON.stringify({ error: 'too many requests' }), {
      status: 429,
      headers: { 'Retry-After': '7' },
    });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RateLimitError);
    const rl = err as RateLimitError;
    expect(rl.status).toBe(429);
    expect(rl.retryAfterMs).toBe(7000);
  });

  it('429 without Retry-After header -> RateLimitError, retryAfterMs undefined', async () => {
    const res = new Response(JSON.stringify({ error: 'too many requests' }), { status: 429 });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it('403 -> RcApiError with permission message', async () => {
    const res = new Response(JSON.stringify({ error: 'forbidden', errorType: 'error-not-allowed' }), {
      status: 403,
    });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RcApiError);
    expect(err.message.toLowerCase()).toContain('permission');
    expect((err as RcApiError).errorType).toBe('error-not-allowed');
  });

  it('non-JSON HTML body on 502 -> generic RcApiError, no throw', async () => {
    const res = new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RcApiError);
    const api = err as RcApiError;
    expect(api.status).toBe(502);
    expect(api.errorType).toBeUndefined();
    expect(api.serverError).toContain('502 Bad Gateway');
  });

  it('generic 400 with errorType -> message includes detail', async () => {
    const res = new Response(JSON.stringify({ error: 'invalid-room', errorType: 'error-room-not-found' }), {
      status: 400,
    });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RcApiError);
    expect((err as RcApiError).status).toBe(400);
    expect(err.message).toContain('invalid-room');
  });

  it('TypeError (network failure) -> RcApiError mentioning the URL/ctx', async () => {
    const err = await mapRcError(new TypeError('fetch failed'), CTX);
    expect(err).toBeInstanceOf(RcApiError);
    expect((err as RcApiError).status).toBe(0);
    expect(err.message).toContain('Cannot reach Rocket.Chat');
    expect(err.message).toContain(CTX);
  });

  it('passthrough an existing Error untouched', async () => {
    const original = new Error('boom');
    const err = await mapRcError(original, CTX);
    expect(err).toBe(original);
  });

  it('wraps a non-Error, non-Response value', async () => {
    const err = await mapRcError('weird', CTX);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('weird');
  });
});
