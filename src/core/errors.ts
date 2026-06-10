// Error types and the Rocket.Chat error mapper.
//
// VERIFIED: @rocket.chat/api-client rejects non-2xx responses with the raw
// fetch `Response` object (NOT an Error). Proxies/load balancers in front of
// Rocket.Chat sometimes return HTML bodies on 5xx, so JSON parsing is guarded.

// ConfigError already lives in config.ts (owned by another builder); re-export
// it here so callers have a single import surface for core errors.
export { ConfigError } from './config.js';

export class RcApiError extends Error {
  readonly status: number;
  readonly errorType?: string;
  readonly serverError?: string;

  constructor(
    message: string,
    status: number,
    opts?: { errorType?: string; serverError?: string },
  ) {
    super(message);
    this.name = 'RcApiError';
    this.status = status;
    this.errorType = opts?.errorType;
    this.serverError = opts?.serverError;
  }
}

export class RateLimitError extends RcApiError {
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    status: number,
    opts?: { errorType?: string; serverError?: string; retryAfterMs?: number },
  ) {
    super(message, status, opts);
    this.name = 'RateLimitError';
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

const AUTH_HINT =
  "Authentication failed — check ROCKETCHAT_TOKEN / ROCKETCHAT_USER_ID. " +
  "PATs should be created with 'Ignore Two Factor Authentication' enabled.";

interface RcErrorBody {
  error?: string;
  errorType?: string;
}

/** Parse Retry-After (seconds, per RFC 7231) into milliseconds. */
function parseRetryAfter(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  // HTTP-date form: compute delta from now.
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Map any rejection from the api-client into a typed, actionable Error.
 * Async because reading a Response body (`.json()`) is async.
 *
 * @param e   the thrown value (Response on non-2xx, TypeError on network fail)
 * @param ctx human context, e.g. "GET /v1/subscriptions.get @ https://chat.example"
 */
export async function mapRcError(e: unknown, ctx: string): Promise<Error> {
  if (e instanceof Response) {
    const status = e.status;

    // Guarded body parse — proxies may return HTML on 5xx/502.
    let body: RcErrorBody = {};
    let rawText: string | undefined;
    try {
      // Clone so a failed .json() doesn't lock out a later text read.
      rawText = await e.clone().text();
      body = JSON.parse(rawText) as RcErrorBody;
    } catch {
      // Non-JSON body (HTML error page, empty, etc.) — keep rawText for context.
    }

    const errorType = body.errorType;
    const serverError = body.error ?? (rawText && !body.error ? truncate(rawText) : undefined);

    if (status === 401) {
      return new RcApiError(AUTH_HINT, status, { errorType, serverError });
    }
    if (status === 429) {
      return new RateLimitError(
        `Rate limited by Rocket.Chat (${ctx}). Wait ~60s and retry.`,
        status,
        { errorType, serverError, retryAfterMs: parseRetryAfter(e) },
      );
    }
    if (status === 403) {
      return new RcApiError(
        `Permission denied (${ctx}). Your account lacks the required permission` +
          (errorType ? ` (${errorType})` : '') +
          `, or you are not a member of the target room.`,
        status,
        { errorType, serverError },
      );
    }

    const detail = body.error ?? errorType ?? rawTextSummary(rawText) ?? 'unknown error';
    return new RcApiError(
      `Rocket.Chat request failed (${status}) at ${ctx}: ${detail}`,
      status,
      { errorType, serverError },
    );
  }

  // fetch itself failed (DNS, connection refused, TLS, offline).
  if (e instanceof TypeError) {
    return new RcApiError(
      `Cannot reach Rocket.Chat at ${ctx} — ${e.message}`,
      0,
      { serverError: e.message },
    );
  }

  // Passthrough an existing Error; wrap anything else.
  if (e instanceof Error) return e;
  return new Error(`Unexpected error at ${ctx}: ${String(e)}`);
}

function truncate(s: string, max = 200): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function rawTextSummary(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  return t.length > 0 ? truncate(t) : undefined;
}
