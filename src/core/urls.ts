// Inbound URL resolution: invert the permalink generator in normalize.ts so a
// human can paste a Rocket.Chat web link and have it resolved to a room +
// (optional) message. This is the dual of permalink():
//
//   permalink() builds  {base}/channel/{name}?msg={id}
//                       {base}/group/{name}?msg={id}
//                       {base}/direct/{rid}?msg={id}
//
// and parseRocketChatUrl() takes any of those back apart.
//
// Thread links: Rocket.Chat's room routes are `/{type}/{ref}/:tab?/:context?`
// (apps/meteor/lib/rooms/roomTypes/{public,private,direct}.ts — patterns
// `/channel/:name/:tab?/:context?`, `/group/:name/...`, `/direct/:rid/...`).
// Navigating into a thread sets `tab: 'thread'` with the thread parent id as
// the `context` segment (apps/meteor/client/views/room/hooks/useGoToThreadList.ts:
// `params: { rid, ..., tab: 'thread' }`). So both of these are real, current RC
// thread links and we accept both:
//   {base}/channel/{name}/thread/{tmid}          (path form)
//   {base}/channel/{name}?msg={tmid}             (query form, what getPermaLink emits)
//
// `getPermaLink` (apps/meteor/client/lib/getPermaLink.ts) always returns the
// query form `${roomURL}?msg=${msgId}`; the path form is produced by in-app
// navigation. extractMessageId() reads whichever is present.

/** Parsed components of a Rocket.Chat web URL. */
export interface ParsedRcUrl {
  /** Room type from the path: 'channel' -> c, 'group' -> p, 'direct' -> d. */
  kind: 'channel' | 'group' | 'direct';
  /** Room reference, URL-decoded. For channel/group this is the name; for
   *  direct this is the room id (rid). RoomDirectory.resolve handles both. */
  roomRef: string;
  /** Target message id (from `?msg=` or a `/thread/<id>` path segment), if any. */
  messageId?: string;
}

/** True if `input` looks like an absolute http(s) URL. */
export function looksLikeUrl(input: string): boolean {
  return /^https?:\/\//i.test(input.trim());
}

/**
 * Compare two URL origins for our "same server" check. We accept a link as
 * being on the configured server when the HOST (hostname + port) matches
 * case-insensitively, tolerating an http/https scheme mismatch and any
 * trailing slash. Rationale: deployments routinely sit behind a TLS-terminating
 * proxy, so a user may have configured `https://` while pasting an `http://`
 * link (or vice-versa) for the very same instance; the host is the identity.
 * We deliberately do NOT require the scheme to match.
 */
function sameHost(a: URL, b: URL): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase();
}

/**
 * Parse a pasted Rocket.Chat web URL into its room + message components, or
 * return null when the input is not a Rocket.Chat room link on the configured
 * server.
 *
 * Accepts (where `{base}` is the configured server origin, scheme-insensitive):
 *   {base}/channel/{name}            -> { kind: 'channel', roomRef: name }
 *   {base}/group/{name}              -> { kind: 'group',   roomRef: name }
 *   {base}/direct/{rid}              -> { kind: 'direct',  roomRef: rid }
 *   ...any of the above with `?msg={id}`           -> messageId = id
 *   {base}/{type}/{ref}/thread/{tmid}              -> messageId = tmid
 *
 * Returns null for: non-URL input, a different host, or a path that is not one
 * of the three room shapes.
 */
export function parseRocketChatUrl(baseUrl: string, input: string): ParsedRcUrl | null {
  const trimmed = input.trim();
  if (!looksLikeUrl(trimmed)) return null;

  let url: URL;
  let base: URL;
  try {
    url = new URL(trimmed);
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  // Must be on the configured server (host match; scheme mismatch tolerated).
  if (!sameHost(url, base)) return null;

  // Split the pathname into non-empty segments. RC room links live at the root
  // (no sub-path mount), so segments[0] is the room type.
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length < 2) return null;

  const typeSegment = segments[0]!.toLowerCase();
  const kind =
    typeSegment === 'channel'
      ? 'channel'
      : typeSegment === 'group'
        ? 'group'
        : typeSegment === 'direct'
          ? 'direct'
          : null;
  if (kind === null) return null;

  let roomRef: string;
  try {
    roomRef = decodeURIComponent(segments[1]!);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
    roomRef = segments[1]!;
  }
  if (roomRef === '') return null;

  // Message id: prefer the `?msg=` query param (the getPermaLink form). Failing
  // that, accept a `/thread/<tmid>` path tab (the in-app navigation form):
  //   segments = [type, ref, 'thread', tmid]
  let messageId: string | undefined;
  const msgParam = url.searchParams.get('msg');
  if (msgParam != null && msgParam !== '') {
    messageId = msgParam;
  } else if (segments.length >= 4 && segments[2]!.toLowerCase() === 'thread') {
    const tmid = segments[3]!;
    if (tmid !== '') messageId = tmid;
  }

  return messageId !== undefined ? { kind, roomRef, messageId } : { kind, roomRef };
}

/**
 * Convenience: extract just the target message id from a pasted URL, or null if
 * the URL has no message component (or is not a valid RC link). Reads the
 * `?msg=` query param or the `/thread/<tmid>` path segment, whichever is
 * present.
 */
export function extractMessageId(baseUrl: string, input: string): string | null {
  const parsed = parseRocketChatUrl(baseUrl, input);
  return parsed?.messageId ?? null;
}
