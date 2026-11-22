// One JSON request from this instance to Rome Cloud, or to a Rome Cloud
// service such as the Discord gateway, signed with the instance's token. Each
// caller names the address and words a refusal for the guardian.

import { cloudBearer } from "./instance-identity.js";

/** How long one request may take before it aborts. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface RomeCloudRequest {
  url: URL;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON body; absent sends none. */
  body?: unknown;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/** What the caller throws for a refusal: Rome Cloud's error code, its words
 *  when it gave any, and the HTTP status (0 before any answer). */
export type Refusal = (code: string, message: string | undefined, status: number) => Error;

/**
 * Sends `request` with the instance's bearer and answers the parsed JSON body
 * of a 2xx (null when it has none). Without a bearer, or for a non-2xx, it throws what `refuse` makes:
 * code `not_enrolled`, or the body's `error` (else `http_<status>`) with its
 * `error_description`.
 */
export async function romeCloudRequest(
  request: RomeCloudRequest,
  refuse: Refusal,
): Promise<unknown> {
  const token = await cloudBearer();
  if (!token) throw refuse("not_enrolled", undefined, 0);
  const fetchImpl = request.fetchImpl ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetchImpl(request.url, {
    method: request.method ?? "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-store",
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    cache: "no-store",
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
  });
  const data = (await response.json().catch(() => null)) as
    | ({ error?: unknown; error_description?: unknown } & Record<string, unknown>)
    | null;
  if (!response.ok) {
    throw refuse(
      typeof data?.error === "string" ? data.error : `http_${response.status}`,
      typeof data?.error_description === "string" ? data.error_description : undefined,
      response.status,
    );
  }
  return data;
}
