import { CliError, type CliBearer } from "./config.js";

function urlFor(host: string, pathAndQuery: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new CliError(
      `Invalid host "${host}". Set ROME_STORE_HOST to an absolute URL (e.g. https://romeos.cc) or unset it to use the default.`,
    );
  }
  const p = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return `${trimmed}${p}`;
}

function authHeaders(bearer: CliBearer): Record<string, string> {
  return { authorization: `Bearer ${bearer.token}` };
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
    return JSON.stringify(body);
  } catch {
    try {
      return await response.text();
    } catch {
      return response.statusText;
    }
  }
}

export async function getJson<T>(host: string, path: string, bearer?: CliBearer): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (bearer) Object.assign(headers, authHeaders(bearer));
  const response = await fetch(urlFor(host, path), { headers });
  if (!response.ok) {
    throw new CliError(`${response.status} ${await readError(response)}`);
  }
  return (await response.json()) as T;
}

export async function postJson<T>(
  host: string,
  path: string,
  body: unknown,
  bearer?: CliBearer,
): Promise<{ response: Response; body: T; setCookies: string[] }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (bearer) Object.assign(headers, authHeaders(bearer));
  const response = await fetch(urlFor(host, path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  const json = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const errField =
      json && typeof json === "object" && "error" in json
        ? (json as { error?: unknown }).error
        : null;
    const msg = typeof errField === "string" ? errField : `HTTP ${response.status}`;
    throw new CliError(msg);
  }
  return { response, body: json as T, setCookies };
}

export async function postMultipart<T>(
  host: string,
  path: string,
  body: FormData,
  headers: Record<string, string>,
  bearer: CliBearer,
): Promise<T> {
  const response = await fetch(urlFor(host, path), {
    method: "POST",
    headers: {
      accept: "application/json",
      ...headers,
      ...authHeaders(bearer),
    },
    body,
  });
  if (!response.ok) {
    throw new CliError(`${response.status} ${await readError(response)}`);
  }
  return (await response.json()) as T;
}

// Pick the Rome Cloud session JWT out of a Set-Cookie list. The cookie value is
// the JWT itself, so parsing the value once is enough.
export function extractSessionToken(setCookies: string[]): string | null {
  for (const cookie of setCookies) {
    const [namePair] = cookie.split(";");
    const eq = namePair.indexOf("=");
    if (eq <= 0) continue;
    const name = namePair.slice(0, eq).trim();
    const value = namePair.slice(eq + 1).trim();
    if (name === "pantheon_session" && value.length > 0) return value;
  }
  return null;
}
