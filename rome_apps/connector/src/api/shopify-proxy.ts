import { readFile } from "node:fs/promises";

import { createAppLogger } from "@rome-os/app-runtime";

import type { ProxiedResponse } from "./composio-client.js";

const log = createAppLogger("shopify_proxy");

/**
 * Shopify is brokered by Rome's own integration (Rome Cloud OAuth), not Composio.
 * On connect, and again each time core renews the hourly token, core writes the
 * credential to a file on the shared `/run/rome` tmpfs (`syncProviderTokenFile`
 * in core's `provider-token-files`); the connector reads exactly that file here,
 * fresh on every call. Path resolution mirrors core's: env override first, else
 * the in-container default.
 */
const DEFAULT_SHOPIFY_TOKEN_FILE = "/run/rome/shopify-oauth-token";

function shopifyTokenFilePath(): string {
  return process.env.ROME_SHOPIFY_TOKEN_FILE?.trim() || DEFAULT_SHOPIFY_TOKEN_FILE;
}

/**
 * A Shopify Admin API credential: the store's offline access token and the
 * store's `.myshopify.com` domain, which is the only host the token opens.
 */
export interface ShopifyOAuthToken {
  accessToken: string;
  shop: string;
}

/**
 * Read the guardian's Shopify credential, or null when Shopify isn't connected
 * (the token file doesn't exist) or the file is unusable. A missing file is the
 * normal "not connected" state, not an error; any other read failure propagates.
 */
export async function readShopifyOAuthToken(): Promise<ShopifyOAuthToken | null> {
  let contents: string;
  try {
    contents = await readFile(shopifyTokenFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    log.warn("shopify token file is not valid JSON; treating as not connected");
    return null;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  const shop = typeof record.shop === "string" ? record.shop.trim().toLowerCase() : "";
  if (!accessToken || !shop) {
    log.warn("shopify token file is missing its token or store; treating as not connected");
    return null;
  }
  return { accessToken, shop };
}

/** The GraphQL Admin API endpoint of a store: `/admin/api/<version>/graphql.json`,
 *  where the version is a release like `2026-10` or `unstable`. */
const SHOPIFY_GRAPHQL_ADMIN_PATH = /^\/admin\/api\/(?:\d{4}-\d{2}|unstable)\/graphql\.json$/;

/**
 * Why a call may not go to the store's Admin API, or null when it may. Shopify
 * requires a new public app to use the GraphQL Admin API only, so the one
 * endpoint allowed is the store's GraphQL endpoint, called with POST. Run it on
 * an endpoint already pinned to the token's store.
 */
export function shopifyGraphqlOnlyRejection(endpoint: string, method: string): string | null {
  // URL parsing resolves dot segments, so `/admin/api/2026-10/../products.json`
  // is checked as the path it reaches.
  const { pathname } = new URL(endpoint);
  if (!SHOPIFY_GRAPHQL_ADMIN_PATH.test(pathname)) {
    return `Shopify calls go only to the GraphQL Admin API, POST /admin/api/<version>/graphql.json, not ${pathname}`;
  }
  if (method !== "POST") {
    return `Shopify's GraphQL Admin API takes POST, not ${method}`;
  }
  return null;
}

/**
 * Proxy a GraphQL request straight to the store's Admin API, authenticating
 * with the store's Rome Cloud-brokered token in `X-Shopify-Access-Token`.
 * Returns the upstream response verbatim (`status`/`data`/`headers`) so the
 * caller maps a non-2xx to a fail-closed action error; a thrown error is a
 * transport failure or an endpoint {@link shopifyGraphqlOnlyRejection} refuses,
 * which throws before the token is used. The caller has already pinned
 * `endpoint` to the token's own store, so the token never reaches another host.
 */
export async function shopifyProxyCall(params: {
  token: ShopifyOAuthToken;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  body?: unknown;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
}): Promise<ProxiedResponse> {
  const rejection = shopifyGraphqlOnlyRejection(params.endpoint, params.method);
  if (rejection) throw new Error(rejection);
  const url = new URL(params.endpoint);
  for (const [name, value] of Object.entries(params.query ?? {})) {
    url.searchParams.set(name, String(value));
  }

  // Caller headers win over the defaults; `Headers` matches names
  // case-insensitively, so `content-type` replaces the default.
  const headers = new Headers({ Accept: "application/json", "User-Agent": "rome-connector" });

  let serializedBody: string | undefined;
  if (params.body !== undefined && params.method !== "GET" && params.method !== "HEAD") {
    if (typeof params.body === "string") {
      serializedBody = params.body;
    } else {
      serializedBody = JSON.stringify(params.body);
      headers.set("Content-Type", "application/json");
    }
  }
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    headers.set(name, value);
  }

  // Pin the credential LAST so caller-supplied `headers` can never override it.
  headers.delete("Authorization");
  headers.set("X-Shopify-Access-Token", params.token.accessToken);

  // Never follow a redirect: fetch keeps custom headers across a cross-origin
  // redirect, so a store redirect (Shopify lets merchants define them) would
  // carry the token off the store. A 3xx returns as-is, and the caller maps a
  // non-2xx to an action error.
  const res = await fetch(url, {
    method: params.method,
    headers,
    body: serializedBody,
    redirect: "manual",
  });

  const text = await res.text();
  let data: unknown = text;
  if (text && (res.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return { status: res.status, data, headers: responseHeaders };
}

/**
 * The GraphQL failure in a 2xx Admin API response, or null. Shopify answers a
 * failed query (a syntax error, a missing scope, throttling) with HTTP 200 and a
 * top-level `errors` array, and a mutation it rejects (validation) with a
 * non-empty `userErrors` array in that mutation's payload, so a 200 alone isn't
 * success.
 */
export function shopifyGraphqlError(data: unknown): string | null {
  const errors = (data as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors) ? errors.length > 0 : errors != null) {
    return JSON.stringify(errors);
  }
  const fields = (data as { data?: unknown } | null)?.data;
  if (!fields || typeof fields !== "object") return null;
  const userErrors = Object.values(fields).flatMap((payload) => {
    const list = (payload as { userErrors?: unknown } | null)?.userErrors;
    return Array.isArray(list) ? list : [];
  });
  return userErrors.length > 0 ? JSON.stringify(userErrors) : null;
}
