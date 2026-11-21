// The instance's half of Rome's own Discord bot: the calls it makes, with the
// instance's token, to the Discord gateway Worker that holds the bot, and to
// Rome Cloud for the link that adds the bot to a server. Contract: rome-cloud
// docs/discord-gateway.md.

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

/** Whether a refusal says this instance's token is no good there. */
export function isDiscordAppCredentialError(error: unknown): boolean {
  return (
    error instanceof DiscordAppRefused && (error.status === 401 || error.code === "not_enrolled")
  );
}

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
  removeServer(serverId: string): Promise<{ removed: boolean; left: boolean }>;
  send(input: { channelId: string; content: string; replyTo?: string }): Promise<{ id: string }>;
  /** Shows the bot typing in a channel, for about ten seconds or until it posts. */
  typing(channelId: string): Promise<void>;
  /** Reacts to a message as the bot with a Unicode emoji. */
  react(input: { channelId: string; messageId: string; emoji: string }): Promise<void>;
  /** Discord's page where the guardian adds the bot to a server. */
  installUrl(): Promise<string>;
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
      return "Discord asked Rome to slow down. Try again in a minute.";
    case "discord_rejected":
      return "Discord did not take the message.";
    case "message_unavailable":
      return "That Discord message is gone.";
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

export function romeCloudDiscordApp(fetchImpl: typeof fetch = globalThis.fetch): DiscordAppCloud {
  const worker = (
    path: string,
    method: "GET" | "POST" | "DELETE",
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
      await worker("/v1/messages", "POST", { channelId, typing: true });
    },
    async react(input) {
      await worker("/v1/reactions", "POST", input);
    },
    async send(input) {
      const data = (await worker("/v1/messages", "POST", input)) as { id?: unknown } | null;
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
  };
}
