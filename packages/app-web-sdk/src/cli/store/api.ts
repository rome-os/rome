import { CliError, type CliBearer } from "./config.js";

function urlFor(host: string, pathAndQuery: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new CliError(
      `Invalid host "${host}". Set ROME_STORE_HOST to an absolute URL (e.g. https://romeos.cc) or unset it to use the default.`,
    );
  }
  return `${trimmed}${pathAndQuery}`;
}

function authHeaders(bearer: CliBearer): Record<string, string> {
  return { authorization: `Bearer ${bearer.token}` };
}

async function readError(response: Response): Promise<string> {
  // Read the body once: after a failed json() the body is consumed, so a
  // text() fallback could never return a non-JSON error page.
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText;
  try {
    const body: unknown = JSON.parse(text);
    if (
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
    ) {
      return (body as { error: string }).error;
    }
  } catch {
    // Not JSON: show the body as sent.
  }
  return text;
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
): Promise<{ body: T; setCookies: string[] }> {
  const response = await fetch(urlFor(host, path), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new CliError(`${response.status} ${await readError(response)}`);
  }
  return { body: (await response.json()) as T, setCookies: response.headers.getSetCookie() };
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
