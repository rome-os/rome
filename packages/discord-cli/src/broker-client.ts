import {
  DISCORD_BROKER_CHANNEL_HEADER,
  DISCORD_BROKER_VERSION,
  type DiscordBrokerEnvelope,
  type DiscordBrokerError,
  type DiscordBrokerErrorEnvelope,
  type DiscordBrokerResponseEnvelope,
  type DiscordBrokerRequest,
} from "@rome/api-types/discord-broker";

export class CoreUnavailableError extends Error {
  constructor(message = "Could not reach the local Rome Core process.") {
    super(message);
    this.name = "CoreUnavailableError";
  }
}

export class CoreProtocolError extends Error {
  constructor(message = "Rome Core returned an unsupported Discord broker response.") {
    super(message);
    this.name = "CoreProtocolError";
  }
}

export interface DiscordBrokerClientDeps {
  fetch: typeof fetch;
  internalApiPort?: string;
  /** The session's channel, from `ROME_CHANNEL`. */
  channel?: string;
}

export async function requestDiscordAuth(
  deps: DiscordBrokerClientDeps,
): Promise<DiscordBrokerEnvelope> {
  return requestBroker(deps, "/_internal/discord/auth", { method: "GET" });
}

export async function requestDiscordApi(
  deps: DiscordBrokerClientDeps,
  request: DiscordBrokerRequest,
): Promise<DiscordBrokerEnvelope> {
  return requestBroker(deps, "/_internal/discord/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

async function requestBroker(
  deps: DiscordBrokerClientDeps,
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> },
): Promise<DiscordBrokerEnvelope> {
  const port = deps.internalApiPort?.trim() || "4141";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new CoreUnavailableError("INTERNAL_API_PORT must be an integer from 1 to 65535.");
  }

  let response: Response;
  try {
    const channel = deps.channel?.trim();
    response = await deps.fetch(
      `http://127.0.0.1:${port}${path}`,
      channel
        ? { ...init, headers: { ...init.headers, [DISCORD_BROKER_CHANNEL_HEADER]: channel } }
        : init,
    );
  } catch {
    throw new CoreUnavailableError();
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CoreProtocolError();
  }
  return validateEnvelope(value);
}

export function validateEnvelope(value: unknown): DiscordBrokerEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoreProtocolError();
  }
  const record = value as Record<string, unknown>;
  if (record.version !== DISCORD_BROKER_VERSION) throw new CoreProtocolError();

  if (Object.hasOwn(record, "error")) {
    if (!isBrokerError(record.error)) throw new CoreProtocolError();
    return {
      version: DISCORD_BROKER_VERSION,
      error: record.error,
    } satisfies DiscordBrokerErrorEnvelope;
  }

  if (
    !Number.isInteger(record.status) ||
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers) ||
    !Object.values(record.headers).every((item) => typeof item === "string") ||
    !Object.hasOwn(record, "body")
  ) {
    throw new CoreProtocolError();
  }
  return {
    version: DISCORD_BROKER_VERSION,
    status: record.status as number,
    headers: record.headers as Record<string, string>,
    body: record.body,
  } satisfies DiscordBrokerResponseEnvelope;
}

function isBrokerError(value: unknown): value is DiscordBrokerError {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === "string" &&
    typeof record.message === "string" &&
    (record.status === undefined || Number.isInteger(record.status)) &&
    (record.retryAfterMs === undefined || typeof record.retryAfterMs === "number")
  );
}
