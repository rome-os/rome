// The instance's half of Rome's own Discord bot: the calls it makes, with the
// instance's token, to the Discord gateway Worker that holds the bot, and to
// Rome Cloud for the link that adds the bot to a server. Contract: rome-cloud
// docs/discord-gateway.md.
//
// Posting, reacting and typing are Discord's own REST calls, made through the
// Worker's proxy (`/v1/discord/*`), which makes them as the bot in the servers
// and direct messages bound to this Rome only. What a call does is decided
// here, so a new Discord feature needs no change at the Worker. The `discord`
// CLI's calls go through the same proxy, as they are (`api`).

import { DISCORD_BROKER_RESPONSE_LIMIT_BYTES } from "@rome/api-types/discord-broker";
import {
  filterConnectionApiResponseHeaders,
  isProtectedConnectionApiRequestHeader,
  type ConnectionApiRequest,
  type ConnectionApiResult,
} from "../../../apps/platform-requests.js";
import { cloudBearer } from "../../../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../../../instance/rome-cloud-origin.js";
import { romeCloudRequest } from "../../../instance/rome-cloud-request.js";

/** The Worker that holds Rome's Discord bot. Part of the product, so not
 *  configuration: there is one, for every Rome. */
const DISCORD_WORKER_ORIGIN = "https://discord.romeos.io";

/** A refusal from the Worker or Rome Cloud, in words the guardian can read. */
export class DiscordAppRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** The HTTP status, 0 when nothing answered. */
    readonly status: number,
  ) {
    super(message);
    this.name = "DiscordAppRefused";
  }
}

/** Whether a refusal says this instance's token is no good there. A 401 that
 *  Discord itself gave, through the proxy, is about the bot, not this Rome. */
export function isDiscordAppCredentialError(error: unknown): boolean {
  return (
    error instanceof DiscordAppRefused &&
    ((error.status === 401 && error.code !== "http_401") || error.code === "not_enrolled")
  );
}

const SNOWFLAKE = /^\d{1,20}$/;

/** Who a reply may mention: the people it names, never everyone or a role,
 *  and not the author of the message it answers by the reply alone. */
const REPLY_MENTIONS = { parse: ["users"], replied_user: false } as const;

interface DiscordAppConnected {
  botId: string;
  botUsername: string;
  depositKey: string;
}

interface DiscordAppBindings {
  servers: Array<{ serverId: string; serverName: string; createdAt: number }>;
  users: Array<{ userId: string; createdAt: number }>;
}

export interface DiscordAppCloud {
  /** Turns the bot on for this instance, depositing into `depositUrl`.
   *  Idempotent: the deposit key stays the same across connects. */
  connect(depositUrl: string, signal?: AbortSignal): Promise<DiscordAppConnected>;
  /** Turns the bot off for this instance: every binding goes, and the bot
   *  leaves servers no other instance uses. Idempotent. */
  disconnect(signal?: AbortSignal): Promise<void>;
  bindings(signal?: AbortSignal): Promise<DiscordAppBindings>;
  /** The servers the bot is in for this instance, as Discord shows them now:
   *  the Worker's proxy lists only this instance's. */
  servers(signal?: AbortSignal): Promise<Array<{ id: string; name: string; icon: string | null }>>;
  removeServer(serverId: string): Promise<{ removed: boolean; left: boolean }>;
  send(input: { channelId: string; content: string; replyTo?: string }): Promise<{ id: string }>;
  /** Shows the bot typing in a channel, for about ten seconds or until it posts. */
  typing(channelId: string): Promise<void>;
  /** Reacts to a message as the bot with a Unicode emoji. */
  react(input: { channelId: string; messageId: string; emoji: string }): Promise<void>;
  /** Takes the bot's own reaction off a message. */
  unreact(input: { channelId: string; messageId: string; emoji: string }): Promise<void>;
  /** Discord's page where the guardian adds the bot to a server. */
  installUrl(): Promise<string>;
  /** One Discord REST call, as the `discord` CLI asks it, through the Worker's
   *  proxy. Discord's answer, or the proxy's refusal, comes back as it is. */
  api(request: ConnectionApiRequest): Promise<ConnectionApiResult>;
}

/** A server's icon on Discord's CDN, from its icon hash; null for none or for
 *  anything that is not a hash, so nothing else ends up in the URL. */
function serverIcon(serverId: string, hash: unknown): string | null {
  return typeof hash === "string" && /^(a_)?[0-9a-f]{32}$/.test(hash)
    ? `https://cdn.discordapp.com/icons/${serverId}/${hash}.png?size=96`
    : null;
}

/** What each refusal means for the guardian. */
function wordsFor(code: string, status: number): string {
  switch (code) {
    case "not_enrolled":
      return "Rome's Discord bot needs this Rome linked to Rome Cloud. Link it in Settings, then try again.";
    case "invalid_deposit_url":
      return "Rome can't receive Discord messages yet. Try again in a minute.";
    case "discord_unavailable":
    case "gateway_unconfigured":
      return "Discord is unavailable right now. Try again later.";
    case "not_bound":
      return "Rome is no longer in that Discord server.";
    case "not_member":
      return "You are no longer in that Discord server, so Rome does not post there.";
    case "channel_unavailable":
      return "Rome can't see that Discord channel any more.";
    case "rate_limited":
    case "http_429":
      return "Discord asked Rome to slow down. Try again in a minute.";
    case "route_denied":
      return "Rome's Discord bot can't do that.";
    // Discord's own answers, passed on by the proxy.
    case "http_401":
      return "Discord did not accept Rome's bot right now. Try again later.";
    case "http_403":
      return "Rome's Discord bot isn't allowed to do that there. A server admin can give it the permission.";
    case "http_404":
      return "That Discord message or channel is gone.";
    default:
      return status === 401
        ? "Rome Cloud did not accept this Rome. Link it again in Settings."
        : `Discord's service answered ${status || "nothing"} (${code}).`;
  }
}

const refuse = (code: string, _message: string | undefined, status: number) =>
  new DiscordAppRefused(code, wordsFor(code, status), status);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A Discord id, before it goes into a path. */
function snowflake(id: string): string {
  if (!SNOWFLAKE.test(id)) throw new Error(`"${id}" is not a Discord id`);
  return id;
}

export function romeCloudDiscordApp(fetchImpl: typeof fetch = globalThis.fetch): DiscordAppCloud {
  const worker = (
    path: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    body?: unknown,
    signal?: AbortSignal,
  ) =>
    romeCloudRequest(
      {
        url: new URL(path, DISCORD_WORKER_ORIGIN),
        method,
        fetchImpl,
        ...(body === undefined ? {} : { body }),
        ...(signal ? { signal } : {}),
      },
      refuse,
    );

  return {
    async connect(depositUrl, signal) {
      const data = (await worker("/v1/connect", "POST", { depositUrl }, signal)) as Record<
        string,
        unknown
      > | null;
      if (!isString(data?.botId) || !isString(data.depositKey)) {
        throw refuse("invalid_response", undefined, 200);
      }
      return {
        botId: data.botId,
        botUsername: isString(data.botUsername) ? data.botUsername : "Rome",
        depositKey: data.depositKey,
      };
    },
    async disconnect(signal) {
      await worker("/v1/connect", "DELETE", undefined, signal);
    },
    async servers(signal) {
      const data = await worker("/v1/discord/users/@me/guilds", "GET", undefined, signal);
      return (Array.isArray(data) ? data : []).flatMap((row: Record<string, unknown>) =>
        isString(row?.id) && SNOWFLAKE.test(row.id)
          ? [
              {
                id: row.id,
                name: typeof row.name === "string" ? row.name : "",
                icon: serverIcon(row.id, row.icon),
              },
            ]
          : [],
      );
    },
    async bindings(signal) {
      const data = (await worker("/v1/bindings", "GET", undefined, signal)) as {
        servers?: unknown;
        users?: unknown;
      } | null;
      const servers = Array.isArray(data?.servers) ? data.servers : [];
      const users = Array.isArray(data?.users) ? data.users : [];
      return {
        servers: servers.flatMap((row: Record<string, unknown>) =>
          isString(row?.serverId)
            ? [
                {
                  serverId: row.serverId,
                  serverName: typeof row.serverName === "string" ? row.serverName : "",
                  createdAt: Number(row.createdAt) || 0,
                },
              ]
            : [],
        ),
        users: users.flatMap((row: Record<string, unknown>) =>
          isString(row?.userId)
            ? [{ userId: row.userId, createdAt: Number(row.createdAt) || 0 }]
            : [],
        ),
      };
    },
    async removeServer(serverId) {
      const data = (await worker(`/v1/bindings/${encodeURIComponent(serverId)}`, "DELETE")) as {
        removed?: unknown;
        left?: unknown;
      } | null;
      return { removed: data?.removed === true, left: data?.left === true };
    },
    async typing(channelId) {
      await worker(`/v1/discord/channels/${snowflake(channelId)}/typing`, "POST");
    },
    async react({ channelId, messageId, emoji }) {
      const path = `/v1/discord/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`;
      await worker(path, "PUT");
    },
    async unreact({ channelId, messageId, emoji }) {
      const path = `/v1/discord/channels/${snowflake(channelId)}/messages/${snowflake(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`;
      await worker(path, "DELETE");
    },
    async send({ channelId, content, replyTo }) {
      const data = (await worker(`/v1/discord/channels/${snowflake(channelId)}/messages`, "POST", {
        content,
        allowed_mentions: REPLY_MENTIONS,
        ...(replyTo
          ? { message_reference: { message_id: snowflake(replyTo), fail_if_not_exists: false } }
          : {}),
      })) as { id?: unknown } | null;
      if (!isString(data?.id)) throw refuse("invalid_response", undefined, 200);
      return { id: data.id };
    },
    async installUrl() {
      const origin = getRomeCloudOrigin();
      if (!origin) throw refuse("not_enrolled", undefined, 0);
      const data = (await romeCloudRequest(
        { url: new URL("/api/instance/discord/install-url", origin), method: "POST", fetchImpl },
        refuse,
      )) as { url?: unknown } | null;
      if (!isString(data?.url) || !data.url.startsWith("https://discord.com/")) {
        throw refuse("invalid_response", undefined, 200);
      }
      return data.url;
    },
    async api(request) {
      const token = await cloudBearer();
      if (!token) throw refuse("not_enrolled", undefined, 0);
      const url = new URL(`/v1/discord${request.path}`, DISCORD_WORKER_ORIGIN);
      for (const [name, value] of request.query) url.searchParams.append(name, value);
      const hasBody = request.body !== null && request.body !== undefined;
      let response: Response;
      let bytes: Uint8Array;
      try {
        response = await fetchImpl(url, {
          method: request.method,
          headers: {
            ...Object.fromEntries(
              Object.entries(request.headers).filter(
                ([name]) => !isProtectedConnectionApiRequestHeader(name),
              ),
            ),
            Authorization: `Bearer ${token}`,
            "Cache-Control": "no-store",
            ...(hasBody ? { "Content-Type": "application/json" } : {}),
          },
          cache: "no-store",
          ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
          signal: AbortSignal.timeout(request.timeoutMs),
        });
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "TimeoutError";
        return {
          error: timedOut
            ? { type: "timeout", message: "Discord did not answer in time." }
            : { type: "network", message: "Rome could not reach Discord's service." },
        };
      }
      if (bytes.byteLength > DISCORD_BROKER_RESPONSE_LIMIT_BYTES) {
        return {
          error: {
            type: "response_too_large",
            message: "Discord response exceeded the 16 MiB broker limit.",
          },
        };
      }
      const text = new TextDecoder().decode(bytes);
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      // The Worker refusing this Rome's token, not Discord refusing the bot.
      const error = (body as { error?: unknown } | null)?.error;
      if (response.status === 401 && typeof error === "string") {
        throw refuse(error, undefined, 401);
      }
      return {
        response: {
          status: response.status,
          headers: filterConnectionApiResponseHeaders(response.headers.entries()),
          body,
        },
      };
    },
  };
}
