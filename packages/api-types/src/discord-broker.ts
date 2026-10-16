export const DISCORD_BROKER_VERSION = 1 as const;
export const DISCORD_API_VERSION = "10" as const;
export const DISCORD_BROKER_REQUEST_LIMIT_BYTES = 1024 * 1024;
export const DISCORD_BROKER_RESPONSE_LIMIT_BYTES = 16 * 1024 * 1024;
export const DISCORD_DEFAULT_TIMEOUT_MS = 30_000;
export const DISCORD_MIN_TIMEOUT_MS = 1_000;
export const DISCORD_MAX_TIMEOUT_MS = 120_000;
/** Names the channel the calling session's turns arrive on, so the broker acts
 *  as the bot backing it. */
export const DISCORD_BROKER_CHANNEL_HEADER = "x-rome-channel";

export const DISCORD_BROKER_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type DiscordBrokerHttpMethod = (typeof DISCORD_BROKER_METHODS)[number];

export interface DiscordBrokerRequest {
  version: typeof DISCORD_BROKER_VERSION;
  method: DiscordBrokerHttpMethod;
  /** API-v10-relative path without a query string. A leading slash is optional. */
  endpoint: string;
  /** Ordered pairs preserve repeated keys and caller order. */
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

export type DiscordBrokerErrorType =
  | "invalid_request"
  | "request_too_large"
  | "response_too_large"
  | "not_paired"
  | "not_authenticated"
  | "credential_rejected"
  | "network"
  | "timeout"
  | "rate_limit"
  | "internal";

export interface DiscordBrokerError {
  type: DiscordBrokerErrorType;
  message: string;
  status?: number;
  retryAfterMs?: number;
}

export interface DiscordBrokerResponseEnvelope {
  version: typeof DISCORD_BROKER_VERSION;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface DiscordBrokerErrorEnvelope {
  version: typeof DISCORD_BROKER_VERSION;
  error: DiscordBrokerError;
}

export type DiscordBrokerEnvelope = DiscordBrokerResponseEnvelope | DiscordBrokerErrorEnvelope;

const PROTECTED_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "user-agent",
  "content-length",
  "content-type",
]);

const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;

export function isDiscordBrokerHttpMethod(value: string): value is DiscordBrokerHttpMethod {
  return (DISCORD_BROKER_METHODS as readonly string[]).includes(value);
}

export function isProtectedDiscordBrokerRequestHeader(name: string): boolean {
  return PROTECTED_REQUEST_HEADERS.has(name.trim().toLowerCase());
}

export class DiscordRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordRequestValidationError";
  }
}

/** Validate and normalize an API-v10-relative path. Query strings are kept out
 * of this helper because the broker contract carries them as ordered pairs. */
export function normalizeDiscordEndpoint(endpoint: string): string {
  if (!endpoint || endpoint.trim() !== endpoint) {
    throw new DiscordRequestValidationError("endpoint must be a non-empty relative path");
  }
  if (/\p{Cc}/u.test(endpoint)) {
    throw new DiscordRequestValidationError("endpoint contains a control character");
  }
  if (endpoint.includes("#")) {
    throw new DiscordRequestValidationError("endpoint fragments are not accepted");
  }
  if (endpoint.includes("?")) {
    throw new DiscordRequestValidationError("endpoint query parameters must use the query field");
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(endpoint) || endpoint.startsWith("//")) {
    throw new DiscordRequestValidationError(
      "absolute and protocol-relative endpoints are not accepted",
    );
  }
  if (endpoint.includes("\\")) {
    throw new DiscordRequestValidationError("endpoint backslashes are not accepted");
  }

  const relative = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  if (!relative) {
    throw new DiscordRequestValidationError("endpoint must be a non-empty relative path");
  }

  const base = new URL("https://discord.com/api/v10/");
  let resolved: URL;
  try {
    resolved = new URL(relative, base);
  } catch {
    throw new DiscordRequestValidationError("endpoint is not a valid relative path");
  }
  if (
    resolved.origin !== base.origin ||
    !resolved.pathname.startsWith("/api/v10/") ||
    resolved.search ||
    resolved.hash ||
    resolved.username ||
    resolved.password
  ) {
    throw new DiscordRequestValidationError("endpoint must stay within Discord API v10");
  }

  const normalized = resolved.pathname.slice("/api/v10".length);
  if (normalized === "/" || !normalized.startsWith("/")) {
    throw new DiscordRequestValidationError("endpoint must name a Discord API resource");
  }
  return normalized;
}

export function validateDiscordBrokerRequest(value: unknown): DiscordBrokerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DiscordRequestValidationError("request must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== DISCORD_BROKER_VERSION) {
    throw new DiscordRequestValidationError("unsupported broker request version");
  }
  if (typeof record.method !== "string") {
    throw new DiscordRequestValidationError("method must be a string");
  }
  const method = record.method.toUpperCase();
  if (!isDiscordBrokerHttpMethod(method)) {
    throw new DiscordRequestValidationError(
      `method must be one of ${DISCORD_BROKER_METHODS.join(", ")}`,
    );
  }
  if (typeof record.endpoint !== "string") {
    throw new DiscordRequestValidationError("endpoint must be a string");
  }
  const endpoint = normalizeDiscordEndpoint(record.endpoint);

  if (!Array.isArray(record.query)) {
    throw new DiscordRequestValidationError("query must be an array of string pairs");
  }
  const query: Array<[string, string]> = record.query.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string" ||
      /\p{Cc}/u.test(pair[0])
    ) {
      throw new DiscordRequestValidationError("query must contain only string pairs");
    }
    return [pair[0], pair[1]];
  });

  if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)) {
    throw new DiscordRequestValidationError("headers must be an object of string values");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(record.headers)) {
    if (
      !HTTP_HEADER_NAME.test(name) ||
      typeof headerValue !== "string" ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/.test(headerValue)
    ) {
      throw new DiscordRequestValidationError("headers must contain valid string names and values");
    }
    if (isProtectedDiscordBrokerRequestHeader(name)) {
      throw new DiscordRequestValidationError(`header ${name} is owned by Rome Core`);
    }
    headers[name] = headerValue;
  }

  if (!Number.isInteger(record.timeoutMs)) {
    throw new DiscordRequestValidationError("timeoutMs must be an integer");
  }
  const timeoutMs = Math.min(
    DISCORD_MAX_TIMEOUT_MS,
    Math.max(DISCORD_MIN_TIMEOUT_MS, record.timeoutMs as number),
  );

  return {
    version: DISCORD_BROKER_VERSION,
    method,
    endpoint,
    query,
    headers,
    body: Object.hasOwn(record, "body") ? record.body : null,
    timeoutMs,
  };
}
