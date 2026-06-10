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

  it('429 with only X-RateLimit-Reset -> retryAfterMs is the delta from now', async () => {
    const resetMs = Date.now() + 5000;
    const res = new Response(JSON.stringify({ error: 'too many requests' }), {
      status: 429,
      headers: { 'X-RateLimit-Reset': String(resetMs) },
    });
    const err = await mapRcError(res, CTX);
    expect(err).toBeInstanceOf(RateLimitError);
    const rl = err as RateLimitError;
    // Allow a little slack for the Date.now() call inside the mapper.
    expect(rl.retryAfterMs).toBeGreaterThan(4000);
    expect(rl.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it('429 with only body details.seconds -> retryAfterMs in ms', async () => {
    const res = new Response(
      JSON.stringify({ error: 'too many requests', details: { seconds: 8 } }),
      { status: 429 },
    );
    const err = await mapRcError(res, CTX);
    expect((err as RateLimitError).retryAfterMs).toBe(8000);
  });

  it('429 with only body details.timeToReset -> retryAfterMs in ms', async () => {
    const res = new Response(
      JSON.stringify({ error: 'too many requests', details: { timeToReset: 3500 } }),
      { status: 429 },
    );
    const err = await mapRcError(res, CTX);
    expect((err as RateLimitError).retryAfterMs).toBe(3500);
  });

  it('429 precedence: Retry-After beats X-RateLimit-Reset beats body details', async () => {
    const res = new Response(
      JSON.stringify({ error: 'too many requests', details: { timeToReset: 99000, seconds: 99 } }),
      {
        status: 429,
        headers: {
          'Retry-After': '4',
          'X-RateLimit-Reset': String(Date.now() + 60000),
        },
      },
    );
    const err = await mapRcError(res, CTX);
    // Retry-After (4s) wins over both the reset header and the body.
    expect((err as RateLimitError).retryAfterMs).toBe(4000);
  });

  it('429 precedence: X-RateLimit-Reset beats body details when no Retry-After', async () => {
    const resetMs = Date.now() + 6000;
    const res = new Response(
      JSON.stringify({ error: 'too many requests', details: { seconds: 99 } }),
      { status: 429, headers: { 'X-RateLimit-Reset': String(resetMs) } },
    );
    const err = await mapRcError(res, CTX);
    const rl = err as RateLimitError;
    expect(rl.retryAfterMs).toBeGreaterThan(5000);
    expect(rl.retryAfterMs).toBeLessThanOrEqual(6000);
  });

  it('429 clamps an absurd X-RateLimit-Reset to the 120s ceiling', async () => {
    // Reset 10 minutes out → clamped to 120000 ms.
    const res = new Response(JSON.stringify({ error: 'too many requests' }), {
      status: 429,
      headers: { 'X-RateLimit-Reset': String(Date.now() + 10 * 60 * 1000) },
    });
    const err = await mapRcError(res, CTX);
    expect((err as RateLimitError).retryAfterMs).toBe(120000);
  });

  it('429 clamps a past X-RateLimit-Reset to 0 (never negative)', async () => {
    const res = new Response(JSON.stringify({ error: 'too many requests' }), {
      status: 429,
      headers: { 'X-RateLimit-Reset': String(Date.now() - 10000) },
    });
    const err = await mapRcError(res, CTX);
    expect((err as RateLimitError).retryAfterMs).toBe(0);
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
