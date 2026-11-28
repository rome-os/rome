import { apiErrorMessageFrom } from "@/lib/api-error";

export class FetchJsonError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface FetchJsonOptions extends Omit<RequestInit, "body" | "credentials" | "cache"> {
  // Serialized as the request body with a JSON content-type. Use this instead
  // of `body` so callers never hand-stringify or set the header.
  json?: unknown;
  // Surfaced as the thrown Error message when the response carries no usable
  // detail/message/error field.
  fallback: string;
}

// The single fetch path for the dashboard's JSON API. Always sends credentials
// and bypasses the HTTP cache (the dashboard relies on the query layer for
// freshness, not the browser cache), and turns any non-2xx into a thrown Error
// whose message is the server's detail — the shape react-query expects, so it
// drops straight into a queryFn or mutationFn.
//
// `credentials`/`cache` are applied *after* the caller's `...init` (and omitted
// from the options type) so they can never be silently overridden. A 204
// resolves to `undefined`, so type the call with a `T` that permits it (e.g.
// `fetchJson<void>`) for endpoints that may return no body.
export async function fetchJson<T>(url: string, options: FetchJsonOptions): Promise<T> {
  const { json, fallback, headers, ...init } = options;
  // Normalize via Headers so every valid HeadersInit shape (object, entry array,
  // or Headers instance) is preserved rather than mangled by an object spread.
  const requestHeaders = new Headers(headers);
  if (json !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: requestHeaders,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new FetchJsonError(
      apiErrorMessageFrom(body, fallback),
      response.status,
      typeof body?.error === "string" ? body.error : undefined,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
