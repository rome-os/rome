import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiDeps } from "../deps.js";
import {
  filterChannelApiResponseHeaders,
  type ChannelApiRequest,
  type ChannelApiResult,
} from "../../channels/api-request.js";
import { createLogger } from "../../logger.js";
import {
  DISCORD_BROKER_CHANNEL_HEADER,
  DISCORD_BROKER_REQUEST_LIMIT_BYTES,
  DISCORD_BROKER_RESPONSE_LIMIT_BYTES,
  DISCORD_BROKER_VERSION,
  DISCORD_DEFAULT_TIMEOUT_MS,
  DiscordRequestValidationError,
  validateDiscordBrokerRequest,
  type DiscordBrokerEnvelope,
  type DiscordBrokerError,
  type DiscordBrokerRequest,
} from "@rome/api-types/discord-broker";
import { CredentialRejected } from "../../connections/errors.js";
import type { Connection } from "../../connections/types.js";
import type { ChannelRecordsRepository } from "../../db/repositories/channel-records.js";

const log = createLogger("discord-cli-broker");

type DiscordCliRouteDeps = Pick<ApiDeps, "connectionRegistry" | "setupManager"> & {
  channelRecords?: Pick<ChannelRecordsRepository, "byId">;
};

export function isLoopbackInternalApiHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function discordCliRoutes(deps: DiscordCliRouteDeps, internalApiHost: string): Hono {
  if (!isLoopbackInternalApiHost(internalApiHost)) {
    throw new Error(
      "Discord CLI broker requires the internal API server to bind to a loopback address",
    );
  }

  const app = new Hono();

  app.get("/_internal/discord/auth", async (c) => {
    const request: ChannelApiRequest = {
      method: "GET",
      path: "/users/@me",
      query: [],
      headers: {},
      body: null,
      timeoutMs: DISCORD_DEFAULT_TIMEOUT_MS,
    };
    const outcome = await execute(deps, request, c.req.header(DISCORD_BROKER_CHANNEL_HEADER));
    return c.json(outcome.body, outcome.status as ContentfulStatusCode);
  });

  app.post("/_internal/discord/api", async (c) => {
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > DISCORD_BROKER_REQUEST_LIMIT_BYTES) {
      return c.json(
        errorEnvelope({
          type: "request_too_large",
          message: "Broker request exceeded the 1 MiB limit.",
        }),
        413,
      );
    }

    const raw = await readRequestBody(c.req.raw, DISCORD_BROKER_REQUEST_LIMIT_BYTES);
    if (raw === null) {
      return c.json(
        errorEnvelope({
          type: "request_too_large",
          message: "Broker request exceeded the 1 MiB limit.",
        }),
        413,
      );
    }

    let brokerRequest: DiscordBrokerRequest;
    try {
      brokerRequest = validateDiscordBrokerRequest(JSON.parse(raw));
    } catch (error) {
      const message =
        error instanceof DiscordRequestValidationError
          ? error.message
          : "request body must be valid JSON";
      return c.json(errorEnvelope({ type: "invalid_request", message }), 400);
    }

    const outcome = await execute(
      deps,
      toChannelApiRequest(brokerRequest),
      c.req.header(DISCORD_BROKER_CHANNEL_HEADER),
    );
    return c.json(outcome.body, outcome.status as ContentfulStatusCode);
  });

  return app;
}

async function execute(
  deps: DiscordCliRouteDeps,
  request: ChannelApiRequest,
  channel: string | undefined,
): Promise<{ status: number; body: DiscordBrokerEnvelope }> {
  const startedAt = Date.now();
  let discordStatus: number | undefined;
  try {
    const { bot, candidates, includeNewAccount } = discordBotFor(deps, channel);
    const act = bot?.act;
    if (!act || !act.operations().some((operation) => operation.name === "discord.api.request")) {
      return unavailableDiscordAuth(deps, candidates, includeNewAccount);
    }

    const result = (await act.invoke({
      operation: "discord.api.request",
      input: request,
    })) as ChannelApiResult;
    if (result.error) return projectFailure(result);

    const responseEnvelope: DiscordBrokerEnvelope = {
      version: DISCORD_BROKER_VERSION,
      status: result.response.status,
      headers: filterChannelApiResponseHeaders(Object.entries(result.response.headers)),
      body: result.response.body,
    };
    discordStatus = result.response.status;
    if (
      Buffer.byteLength(JSON.stringify(responseEnvelope), "utf8") >
      DISCORD_BROKER_RESPONSE_LIMIT_BYTES
    ) {
      return {
        status: 502,
        body: errorEnvelope({
          type: "response_too_large",
          message: "Discord response exceeded the 16 MiB broker limit.",
        }),
      };
    }
    return { status: 200, body: responseEnvelope };
  } catch (error) {
    if (error instanceof CredentialRejected) return credentialRejected();
    log.error("discord broker request failed", {
      method: request.method,
      endpoint: request.path,
      durationMs: Date.now() - startedAt,
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return {
      status: 500,
      body: errorEnvelope({
        type: "internal",
        message: "Rome Core could not complete the Discord request.",
      }),
    };
  } finally {
    log.info("discord broker request completed", {
      method: request.method,
      endpoint: request.path,
      discordStatus,
      durationMs: Date.now() - startedAt,
    });
  }
}

/** The bot backing the caller's Discord channel, resolved per request because
 * a reconnect re-backs a channel with a new Connection. A Discord channel never
 * acts as another bot, so one whose bot is missing or locked is unavailable.
 * A caller on no Discord channel gets the first bot that can act, so an
 * unfinished account never hides a live one. The channel is the caller's
 * claim, so this picks a bot rather than enforcing a boundary between them. */
function discordBotFor(
  deps: DiscordCliRouteDeps,
  channel: string | undefined,
): { bot: Connection | undefined; candidates: Connection[] | null; includeNewAccount: boolean } {
  const bots = deps.connectionRegistry?.find("discord") ?? [];
  const record = channel ? deps.channelRecords?.byId(channel) : null;
  if (record?.service === "discord") {
    const own = bots.find((bot) => bot.id === record.connectionId);
    // A failure then describes the channel's own bot, not every Discord bot.
    // A channel with no Connection waits for the service's next one, which
    // may be mid-setup.
    return { bot: own, candidates: own ? [own] : [], includeNewAccount: !record.connectionId };
  }
  return {
    bot: bots.find((bot) => bot.isUnlocked("act")) ?? bots[0],
    candidates: null,
    includeNewAccount: true,
  };
}

function projectFailure(result: Extract<ChannelApiResult, { error: unknown }>): {
  status: number;
  body: DiscordBrokerEnvelope;
} {
  const status = result.error.type === "timeout" || result.error.type === "rate_limit" ? 504 : 502;
  return {
    status,
    body: errorEnvelope({
      type: result.error.type,
      message: result.error.message,
      retryAfterMs: result.error.retryAfterMs,
    }),
  };
}

function toChannelApiRequest(request: DiscordBrokerRequest): ChannelApiRequest {
  return {
    method: request.method,
    path: request.endpoint,
    query: request.query,
    headers: request.headers,
    body: request.body,
    timeoutMs: request.timeoutMs,
  };
}

function notAuthenticated(): { status: number; body: DiscordBrokerEnvelope } {
  return {
    status: 401,
    body: errorEnvelope({
      type: "not_authenticated",
      message: "Discord is not connected through Rome. Connect it in Settings -> Connections.",
    }),
  };
}

function notPaired(): { status: number; body: DiscordBrokerEnvelope } {
  return {
    status: 409,
    body: errorEnvelope({
      type: "not_paired",
      message:
        "Discord connection setup is in progress, but your account is not paired yet. Finish pairing in Settings -> Connections.",
    }),
  };
}

function credentialRejected(): { status: number; body: DiscordBrokerEnvelope } {
  return {
    status: 401,
    body: errorEnvelope({
      type: "credential_rejected",
      status: 401,
      message:
        "Discord rejected Rome's bot credential. Reconnect Discord in Settings -> Connections.",
    }),
  };
}

/** Why no bot can act. `candidates` narrows the diagnosis to a channel's own
 *  bot, and null means every Discord bot. */
function unavailableDiscordAuth(
  deps: DiscordCliRouteDeps,
  candidates: Connection[] | null,
  includeNewAccount: boolean,
): {
  status: number;
  body: DiscordBrokerEnvelope;
} {
  const bots = candidates ?? deps.connectionRegistry?.find("discord") ?? [];
  if (hasActiveDiscordSetup(deps, bots, includeNewAccount)) return notPaired();
  const rejected = bots.some((connection) => connection.auth.grants().bot === "degraded");
  return rejected ? credentialRejected() : notAuthenticated();
}

function hasActiveDiscordSetup(
  deps: DiscordCliRouteDeps,
  bots: Connection[],
  includeNewAccount: boolean,
): boolean {
  const manager = deps.setupManager;
  if (!manager) return false;
  if (includeNewAccount && manager.activeFor("discord", "bot")) return true;
  return bots.some((connection) => Boolean(manager.activeFor(connection.id, "bot")));
}

function errorEnvelope(error: DiscordBrokerError): DiscordBrokerEnvelope {
  return { version: DISCORD_BROKER_VERSION, error };
}

/** Read a possibly chunked request without letting an absent Content-Length
 * bypass the broker's memory boundary. Null means the limit was exceeded. */
async function readRequestBody(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
