import { readFile } from "node:fs/promises";

import { createAppLogger } from "@rome-os/app-runtime";

import type { ProxiedResponse } from "./composio-client.js";

const log = createAppLogger("slack_proxy");

/**
 * Slack is brokered by Rome's own integration (Rome Cloud OAuth), not Composio.
 * On connect, core writes the Slack credential to a file on the shared
 * `/run/rome` tmpfs (`syncProviderTokenFile` in core's `provider-token-files`);
 * the connector reads exactly that file here. Path resolution mirrors core's —
 * env override first, else the in-container default — kept in lockstep by
 * convention (both default to the same constant).
 */
const DEFAULT_SLACK_TOKEN_FILE = "/run/rome/slack-oauth-token";

function slackTokenFilePath(): string {
  return process.env.ROME_SLACK_TOKEN_FILE?.trim() || DEFAULT_SLACK_TOKEN_FILE;
}

/**
 * Slack v2 yields two tokens from one install: a bot token (`xoxb-`) for most
 * Web API methods, and a user token (`xoxp-`) the installer acts as — needed for
 * `search.*`, which a bot token can't call. `teamId` namespaces the workspace.
 */
export interface SlackOAuthTokens {
  botToken: string;
  userToken: string | null;
  teamId: string | null;
}

/**
 * Read the guardian's Slack OAuth tokens, or null when Slack isn't connected
 * (the token file doesn't exist) or the file is unusable (malformed JSON, or no
 * bot token). A missing file is the normal "not connected" state, not an error;
 * any other read failure propagates.
 */
export async function readSlackOAuthTokens(): Promise<SlackOAuthTokens | null> {
  let contents: string;
  try {
    contents = await readFile(slackTokenFilePath(), "utf8");
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
    // A present-but-corrupt file is NOT the normal "not connected" state (that's
    // a missing file, handled above). Warn so it's distinguishable in logs rather
    // than silently looking unconnected.
    log.warn("slack token file is not valid JSON; treating as not connected");
    return null;
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  const botToken = typeof record.botToken === "string" ? record.botToken.trim() : "";
  if (!botToken) {
    log.warn("slack token file is missing a bot token; treating as not connected");
    return null;
  }
  return {
    botToken,
    userToken: typeof record.userToken === "string" ? record.userToken : null,
    teamId: typeof record.teamId === "string" ? record.teamId : null,
  };
}

/**
 * Pick the token a Slack Web API call authenticates with. `search.*` (e.g.
 * `search.messages`) only works with the user token; everything else uses the
 * bot token. The method name is the last path segment of `/api/<method>`.
 */
export function selectSlackToken(endpoint: string, tokens: SlackOAuthTokens): string {
  const method = new URL(endpoint).pathname.replace(/^\/api\//, "");
  if (method.startsWith("search.")) {
    if (!tokens.userToken) {
      throw new Error(
        `Slack "${method}" requires the user token, which isn't available — reconnect Slack at Settings → Connections to grant search access.`,
      );
    }
    return tokens.userToken;
  }
  return tokens.botToken;
}

/**
 * Proxy a raw HTTP request straight to Slack's Web API, authenticating with the
 * guardian's Rome Cloud-brokered OAuth token — Rome's own proxy path for Slack,
 * bypassing Composio entirely. Returns the upstream response verbatim
 * (`status`/`data`/`headers`) so the caller maps a non-2xx status to a
 * fail-closed action error, exactly as the GitHub/Composio paths do; a thrown
 * error is a transport failure or a missing-token-for-search refusal. `endpoint`
 * is already host-allowlist validated by the caller, so the token is only ever
 * sent to a slack.com host.
 */
export async function slackProxyCall(params: {
  tokens: SlackOAuthTokens;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  body?: unknown;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
}): Promise<ProxiedResponse> {
  const token = selectSlackToken(params.endpoint, params.tokens);

  const url = new URL(params.endpoint);
  for (const [name, value] of Object.entries(params.query ?? {})) {
    url.searchParams.set(name, String(value));
  }

  // Caller headers win over the defaults so an explicit Content-Type can override
  // Slack's JSON default (e.g. a form-encoded call). `Headers` matches names
  // case-insensitively, so `content-type` replaces the default.
  const headers = new Headers({ "User-Agent": "rome-connector" });

  let serializedBody: string | undefined;
  if (params.body !== undefined && params.method !== "GET" && params.method !== "HEAD") {
    if (typeof params.body === "string") {
      serializedBody = params.body;
    } else {
      serializedBody = JSON.stringify(params.body);
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
  }
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    headers.set(name, value);
  }

  // Pin the credential LAST so caller-supplied `headers` can never override the
  // injected token — Rome owns the Authorization header, the agent never sets it.
  headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(url, { method: params.method, headers, body: serializedBody });

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
