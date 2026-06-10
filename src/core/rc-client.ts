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
//
// TYPED SURFACE: the typed endpoint methods below derive their param/return
// types from @rocket.chat/rest-typings via OperationResult + Serialized (the
// api-client itself returns `Serialized<OperationResult<...>>`). All routes
// funnel through the single private `request` helper so the semaphore /
// 429-backoff / mapRcError plumbing is shared.
import { RestClient } from '@rocket.chat/api-client';
import type { OperationResult } from '@rocket.chat/rest-typings';
import type { IMessage, Serialized } from '@rocket.chat/core-typings';
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

// ---------------------------------------------------------------------------
// Response types (re-exported for wave-2 consumers).
//
// The api-client returns `Serialized<OperationResult<'GET'|'POST', path>>`,
// i.e. the rest-typings result shape with Dates/etc. narrowed to their
// JSON-deserialized forms. We mirror that here so consumers see exactly what
// they will receive at runtime.
// ---------------------------------------------------------------------------

export type SubscriptionsGetResult = Serialized<OperationResult<'GET', '/v1/subscriptions.get'>>;

// channels/groups/im.history are NOT structurally identical in rest-typings:
//   - /v1/channels.history & /v1/groups.history => PaginatedResult<{ messages: IMessage[] }>
//   - /v1/im.history                            => { messages: Pick<IMessage, ...>[] } (narrower,
//                                                   no count/offset/total pagination fields)
// Per the brief we expose ONE return type for getHistory(): the channels.history
// result (the richest of the three). The runtime payload for the c/p/d variants
// is structurally compatible with this superset (im.history simply omits the
// pagination fields and ships a narrower message projection).
export type HistoryResult = Serialized<OperationResult<'GET', '/v1/channels.history'>>;

// syncMessages: the installed rest-typings declare `result.cursor` as REQUIRED
// (`{ next, previous }`). The live server omits `cursor` entirely on the
// non-paginated `lastUpdate` path — see
// apps/meteor/server/publications/messages.ts -> handleWithoutPagination, which
// returns `{ updated, deleted }` with no cursor. We therefore redefine the
// result locally with `cursor` optional so callers that hit the lastUpdate path
// type-check correctly. Message shape is reused from rest-typings (serialized).
type SerializedMessage = Serialized<IMessage>;
export interface SyncMessagesResult {
  result: {
    updated: SerializedMessage[];
    deleted: { _id: string; _deletedAt: string }[];
    // Optional: present only on the cursor/pagination path; absent on the
    // lastUpdate path (handleWithoutPagination).
    cursor?: {
      next: string | null;
      previous: string | null;
    };
  };
}

export type ThreadMessagesResult = Serialized<OperationResult<'GET', '/v1/chat.getThreadMessages'>>;
export type ThreadsListResult = Serialized<OperationResult<'GET', '/v1/chat.getThreadsList'>>;
export type SearchMessagesResult = Serialized<OperationResult<'GET', '/v1/chat.search'>>;
export type PostMessageResult = Serialized<OperationResult<'POST', '/v1/chat.postMessage'>>;
// /v1/chat.react returns void in rest-typings; the server sends `{ success: true }`.
export type ReactResult = Serialized<OperationResult<'POST', '/v1/chat.react'>>;
export type UserInfoResult = Serialized<OperationResult<'GET', '/v1/users.info'>>;
export type GetMessageResult = Serialized<OperationResult<'GET', '/v1/chat.getMessage'>>;

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

  // -------------------------------------------------------------------------
  // Typed endpoint surface
  // -------------------------------------------------------------------------

  /** GET /v1/subscriptions.get — subscription delta since `updatedSince`. */
  getSubscriptions(updatedSince?: string): Promise<SubscriptionsGetResult> {
    return this.request<SubscriptionsGetResult>(
      'GET',
      '/v1/subscriptions.get',
      updatedSince === undefined ? {} : { updatedSince },
    );
  }

  /**
   * GET /v1/{channels|groups|im}.history — room message history.
   * `roomType` selects the endpoint family ('c' => channels, 'p' => groups,
   * 'd' => im). Returns the channels.history shape (see HistoryResult).
   */
  getHistory(
    roomType: 'c' | 'p' | 'd',
    params: {
      roomId: string;
      latest?: string;
      oldest?: string;
      count?: number;
      offset?: number;
      showThreadMessages?: boolean;
    },
  ): Promise<HistoryResult> {
    const endpoint =
      roomType === 'c'
        ? '/v1/channels.history'
        : roomType === 'p'
          ? '/v1/groups.history'
          : '/v1/im.history';
    // rest-typings types `showThreadMessages` as the string 'true'|'false';
    // the server accepts the boolean over the wire. Normalize to string to
    // match the documented param contract.
    const query: Record<string, unknown> = {
      roomId: params.roomId,
      ...(params.latest !== undefined && { latest: params.latest }),
      ...(params.oldest !== undefined && { oldest: params.oldest }),
      ...(params.count !== undefined && { count: params.count }),
      ...(params.offset !== undefined && { offset: params.offset }),
      ...(params.showThreadMessages !== undefined && {
        showThreadMessages: String(params.showThreadMessages),
      }),
    };
    return this.request<HistoryResult>('GET', endpoint, query);
  }

  /**
   * GET /v1/chat.syncMessages — message delta for a room.
   * Uses the lastUpdate path; the result `cursor` is optional (absent here).
   * See SyncMessagesResult for the version note.
   */
  syncMessages(params: {
    roomId: string;
    lastUpdate: string;
    count?: number;
    next?: string;
  }): Promise<SyncMessagesResult> {
    const query: Record<string, unknown> = {
      roomId: params.roomId,
      lastUpdate: params.lastUpdate,
      ...(params.count !== undefined && { count: params.count }),
      ...(params.next !== undefined && { next: params.next }),
    };
    return this.request<SyncMessagesResult>('GET', '/v1/chat.syncMessages', query);
  }

  /** GET /v1/chat.getThreadMessages — messages in a thread (by tmid). */
  getThreadMessages(params: {
    tmid: string;
    count?: number;
    offset?: number;
  }): Promise<ThreadMessagesResult> {
    const query: Record<string, unknown> = {
      tmid: params.tmid,
      ...(params.count !== undefined && { count: params.count }),
      ...(params.offset !== undefined && { offset: params.offset }),
    };
    return this.request<ThreadMessagesResult>('GET', '/v1/chat.getThreadMessages', query);
  }

  /** GET /v1/chat.getThreadsList — thread main-messages for a room (by rid). */
  getThreadsList(params: {
    rid: string;
    count?: number;
    offset?: number;
    text?: string;
  }): Promise<ThreadsListResult> {
    const query: Record<string, unknown> = {
      rid: params.rid,
      ...(params.count !== undefined && { count: params.count }),
      ...(params.offset !== undefined && { offset: params.offset }),
      ...(params.text !== undefined && { text: params.text }),
    };
    return this.request<ThreadsListResult>('GET', '/v1/chat.getThreadsList', query);
  }

  /** GET /v1/chat.search — full-text message search within a room. */
  searchMessages(params: {
    roomId: string;
    searchText: string;
    count?: number;
  }): Promise<SearchMessagesResult> {
    const query: Record<string, unknown> = {
      roomId: params.roomId,
      searchText: params.searchText,
      ...(params.count !== undefined && { count: params.count }),
    };
    return this.request<SearchMessagesResult>('GET', '/v1/chat.search', query);
  }

  /**
   * POST /v1/chat.postMessage — send a message.
   * rest-typings models the body as `roomId` XOR `channel`; we accept both
   * optional and forward as-is (the server requires exactly one).
   */
  postMessage(body: {
    roomId?: string;
    channel?: string;
    text?: string;
    tmid?: string;
  }): Promise<PostMessageResult> {
    return this.request<PostMessageResult>('POST', '/v1/chat.postMessage', { ...body });
  }

  /** POST /v1/chat.react — toggle/set a reaction on a message. */
  react(body: {
    messageId: string;
    emoji: string;
    shouldReact?: boolean;
  }): Promise<ReactResult> {
    const payload: Record<string, unknown> = {
      messageId: body.messageId,
      emoji: body.emoji,
      ...(body.shouldReact !== undefined && { shouldReact: body.shouldReact }),
    };
    return this.request<ReactResult>('POST', '/v1/chat.react', payload);
  }

  /** GET /v1/users.info — user profile by id or username. */
  userInfo(params: { userId?: string; username?: string }): Promise<UserInfoResult> {
    const query: Record<string, unknown> = {
      ...(params.userId !== undefined && { userId: params.userId }),
      ...(params.username !== undefined && { username: params.username }),
    };
    return this.request<UserInfoResult>('GET', '/v1/users.info', query);
  }

  /** GET /v1/chat.getMessage — a single message by id. */
  getMessage(params: { msgId: string }): Promise<GetMessageResult> {
    return this.request<GetMessageResult>('GET', '/v1/chat.getMessage', { msgId: params.msgId });
  }

  /**
   * Single dispatch point: acquires the semaphore, runs with 429-aware
   * backoff + error mapping, releases. The api-client's path-pattern generics
   * are too strict for this string-routed wrapper, so the casts to `never`
   * are isolated here and never leak into the public typed signatures above.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    endpoint: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const ctx = `${method} ${endpoint} @ ${this.baseUrl}`;
    const call =
      method === 'GET'
        ? () => this.client.get(endpoint as never, (payload ?? {}) as never) as Promise<T>
        : () => this.client.post(endpoint as never, (payload ?? {}) as never) as Promise<T>;
    return this.run<T>(ctx, call);
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
