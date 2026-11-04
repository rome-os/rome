/** HTTP methods a connection's authenticated platform API accepts. */
export const CONNECTION_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ConnectionApiHttpMethod = (typeof CONNECTION_API_METHODS)[number];

/**
 * A request a connection runs under its grant's current epoch, the same for
 * every kind of connection.
 *
 * `path` is provider-relative by design: implementations own the API origin
 * and authentication material, so callers can neither choose a host nor read
 * a credential.
 */
export interface ConnectionApiRequest {
  method: ConnectionApiHttpMethod;
  path: string;
  /** Ordered pairs preserve repeated keys and caller order. */
  query: Array<[string, string]>;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
}

export interface ConnectionApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type ConnectionApiFailureType = "network" | "timeout" | "rate_limit" | "response_too_large";

export interface ConnectionApiFailure {
  type: ConnectionApiFailureType;
  message: string;
  retryAfterMs?: number;
}

/** Serializable connection-epoch result with no SDK objects or credentials. */
export type ConnectionApiResult =
  | { response: ConnectionApiResponse; error?: never }
  | { response?: never; error: ConnectionApiFailure };

const PROTECTED_REQUEST_HEADERS = new Set([
  "authorization",
  "host",
  "user-agent",
  "content-length",
  "content-type",
]);

const UNSAFE_RESPONSE_HEADERS = new Set(["authorization", "proxy-authorization", "set-cookie"]);

export function isConnectionApiHttpMethod(value: string): value is ConnectionApiHttpMethod {
  return (CONNECTION_API_METHODS as readonly string[]).includes(value);
}

export function isProtectedConnectionApiRequestHeader(name: string): boolean {
  return PROTECTED_REQUEST_HEADERS.has(name.trim().toLowerCase());
}

export function filterConnectionApiResponseHeaders(
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
