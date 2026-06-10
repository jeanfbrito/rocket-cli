// The ONLY file that imports @rocket.chat/api-client. Everything else in the
// codebase talks to Rocket.Chat through RcClient.
//
// VERIFIED facts:
//  - Constructor: new RestClient({ baseUrl, credentials }). baseUrl is the bare
//    origin; the client appends `/api` itself.
//  - credentials uses exact header-name keys: { 'X-User-Id', 'X-Auth-Token' }.
//  - Calls: client.get('/v1/...', params) / client.post('/v1/...', body).
//  - CJS package; plain named import works under NodeNext.
//  - Non-2xx rejects with the raw fetch Response (handled by mapRcError).
import { RestClient } from '@rocket.chat/api-client';
import { RateLimitError, mapRcError } from './errors.js';
import { log } from './log.js';

export interface RcClientConfig {
  url: string;
  token: string;
  userId: string;
}

const MAX_CONCURRENT = 2;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 2000, 4000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RcClient {
  private readonly client: RestClient;
  private readonly baseUrl: string;

  // Global semaphore: at most MAX_CONCURRENT in-flight requests across the
  // whole process. Waiters are released FIFO as slots free up.
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(config: RcClientConfig) {
    this.baseUrl = config.url;
    this.client = new RestClient({
      baseUrl: config.url,
      credentials: {
        'X-User-Id': config.userId,
        'X-Auth-Token': config.token,
      },
    });
  }

  async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    return this.run<T>(
      `GET ${endpoint} @ ${this.baseUrl}`,
      // api-client's path-pattern generics are too strict for a generic
      // wrapper; the casts are isolated to this file by design.
      () => this.client.get(endpoint as never, (params ?? {}) as never) as Promise<T>,
    );
  }

  async post<T>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
    return this.run<T>(
      `POST ${endpoint} @ ${this.baseUrl}`,
      () => this.client.post(endpoint as never, (body ?? {}) as never) as Promise<T>,
    );
  }

  /** Acquire semaphore, run with 429-aware backoff, map errors, release. */
  private async run<T>(ctx: string, call: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await this.withBackoff<T>(ctx, call);
    } finally {
      this.release();
    }
  }

  private async withBackoff<T>(ctx: string, call: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error(`Request failed at ${ctx}`);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await call();
      } catch (raw) {
        const mapped = await mapRcError(raw, ctx);
        lastError = mapped;
        if (mapped instanceof RateLimitError && attempt < MAX_ATTEMPTS - 1) {
          const delay = mapped.retryAfterMs ?? BACKOFF_MS[attempt] ?? 4000;
          log.warn(`Rate limited (${ctx}); retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
          await sleep(delay);
          continue;
        }
        throw mapped;
      }
    }
    throw lastError;
  }

  private acquire(): Promise<void> {
    if (this.active < MAX_CONCURRENT) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}
