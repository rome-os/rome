import { readFile } from "node:fs/promises";

import type { ProxiedResponse } from "./composio-client.js";

/**
 * GitHub is brokered by Rome's own integration (Rome Cloud OAuth), not Composio:
 * core persists the guardian's GitHub OAuth access token to a file on connect
 * (`syncGithubShellIntegrationForProvider` in core's `github-shell-integration`),
 * the same credential `gh`/git use. This mirrors core's path resolution — env
 * override first, else the in-container default — so the connector reads exactly
 * the token core wrote. Kept in lockstep by convention; both sides default to the
 * same constant.
 */
const DEFAULT_GITHUB_TOKEN_FILE = "/run/rome/github-oauth-token";

function githubTokenFilePath(): string {
  return process.env.ROME_GITHUB_TOKEN_FILE?.trim() || DEFAULT_GITHUB_TOKEN_FILE;
}

/**
 * Read the guardian's GitHub OAuth access token, or null when GitHub isn't
 * connected (the token file doesn't exist yet). A missing file is the normal
 * "not connected" state, not an error; any other read failure propagates.
 */
export async function readGithubOAuthToken(): Promise<string | null> {
  try {
    const token = (await readFile(githubTokenFilePath(), "utf8")).trim();
    return token || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Proxy a raw HTTP request straight to GitHub's REST/GraphQL API, authenticating
 * with the guardian's Rome Cloud-brokered OAuth token — Rome's own proxy path for
 * GitHub, bypassing Composio entirely. Returns the upstream response verbatim
 * (`status`/`data`/`headers`) so the caller maps a non-2xx status to a fail-closed
 * action error, exactly as it does for the Composio path; a thrown error is a
 * transport failure. `endpoint` is already host-allowlist validated by the caller,
 * so the token is only ever sent to a github.com host.
 */
export async function githubProxyCall(params: {
  token: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  body?: unknown;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
}): Promise<ProxiedResponse> {
  const url = new URL(params.endpoint);
  for (const [name, value] of Object.entries(params.query ?? {})) {
    url.searchParams.set(name, String(value));
  }

  // Caller headers win over the defaults so an explicit Accept/Content-Type
  // (e.g. a GraphQL or raw-blob request) can override GitHub's JSON defaults.
  // `Headers` matches names case-insensitively, so `x-github-api-version`
  // replaces the default instead of being joined to it as "a, b".
  const headers = new Headers({
    Authorization: `Bearer ${params.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rome-connector",
  });

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
