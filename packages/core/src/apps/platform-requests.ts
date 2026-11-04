/** HTTP methods supported by a channel's authenticated provider API surface. */
export const CHANNEL_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ChannelApiHttpMethod = (typeof CHANNEL_API_METHODS)[number];

/**
 * Provider-neutral request executed by the current channel connection epoch.
 *
 * `path` is provider-relative by design: implementations own the API origin
 * and authentication material, so callers can neither choose a host nor read
 * a credential.
 */
export interface ChannelApiRequest {
  method: ChannelApiHttpMethod;
  path: string;
  /** Ordered pairs preserve repeated keys and caller order. */
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

export interface ChannelApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type ChannelApiFailureType = "network" | "timeout" | "rate_limit" | "response_too_large";

export interface ChannelApiFailure {
  type: ChannelApiFailureType;
  message: string;
  retryAfterMs?: number;
}

/** Serializable connection-epoch result with no SDK objects or credentials. */
export type ChannelApiResult =
  | { response: ChannelApiResponse; error?: never }
  | { response?: never; error: ChannelApiFailure };

const PROTECTED_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "user-agent",
  "content-length",
  "content-type",
]);

const UNSAFE_RESPONSE_HEADERS = new Set(["authorization", "proxy-authorization", "set-cookie"]);

export function isChannelApiHttpMethod(value: string): value is ChannelApiHttpMethod {
  return (CHANNEL_API_METHODS as readonly string[]).includes(value);
}

export function isProtectedChannelApiRequestHeader(name: string): boolean {
  return PROTECTED_REQUEST_HEADERS.has(name.trim().toLowerCase());
}

export function filterChannelApiResponseHeaders(
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const safe: Array<[string, string]> = [];
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!UNSAFE_RESPONSE_HEADERS.has(name)) safe.push([name, value]);
  }
  safe.sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(safe);
}
