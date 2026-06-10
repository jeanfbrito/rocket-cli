import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { App } from '../../core/app.js';
import { fail, ok } from './shared.js';
import type { UserInfoResult } from '../../core/rc-client.js';

/** Heuristic: looks like a user id (alphanumeric, 17 chars typical RC id). */
function looksLikeId(value: string): boolean {
  return /^[a-zA-Z0-9]{15,}$/.test(value);
}

export function registerGetUserProfileTool(server: McpServer, app: App): void {
  server.registerTool(
    'get_user_profile',
    {
      description:
        "Look up a Rocket.Chat user's profile. Pass a username (with or " +
        "without the leading '@') or a user id. Useful before opening a DM " +
        'via send_message with \'@username\' to confirm the user exists and ' +
        'check their status.',
      inputSchema: {
        user: z
          .string()
          .describe("username (with or without leading '@') or user id"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ user }) => {
      try {
        const stripped = user.startsWith('@') ? user.slice(1) : user;

        let info: UserInfoResult;
        try {
          info = await app.rc.userInfo({ username: stripped });
        } catch (firstErr) {
          if (looksLikeId(stripped)) {
            info = await app.rc.userInfo({ userId: stripped });
          } else {
            throw firstErr;
          }
        }

        const u = info.user;

        // Pick the first verified email, then fall back to first email.
        const emailEntry =
          u.emails?.find((e) => e.verified) ?? u.emails?.[0];
        const email = emailEntry?.address;

        const payload: Record<string, unknown> = {
          id: u._id,
          username: u.username,
          name: u.name,
          status: u.status,
          timezone: u.utcOffset,
        };
        if (u.statusText != null) payload['statusText'] = u.statusText;
        if (u.bio != null) payload['bio'] = u.bio;
        if (u.roles != null) payload['roles'] = u.roles;
        if (email != null) payload['email'] = email;

        return ok(payload);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
