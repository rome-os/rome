import type {
  ConciergeConnectEntry,
  ConciergeConnectorDto,
  ConciergeConnectorsResponse,
} from "@rome/api-types/concierge";

// The client side of a Concierge connect card: start a service's connection from
// the `connect` entry the Concierge's connector list gave it, then watch that
// list until the service works. Every service difference comes from the entry.

export const CONNECT_POLL_INTERVAL_MS = 2500;
/** About two minutes for the guardian to finish in the tab that opened. */
export const CONNECT_POLL_ATTEMPTS = 48;
const LOGIN_ATTEMPT_MS = CONNECT_POLL_INTERVAL_MS * CONNECT_POLL_ATTEMPTS;

/** Where a connect entry that needs the guardian's own page sends them. */
export const SETTINGS_CONNECTIONS_PATH = "/settings/connections";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A link the card may open: a web address, never a script. */
function webUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** A path on this Rome's own API, the only place a card calls. */
function apiPath(value: unknown): string | null {
  return typeof value === "string" && value.startsWith("/api/") && !value.includes("..")
    ? value
    : null;
}

async function json(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => ({}));
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { ok: res.ok, body: await json(res) };
}

/** The link a start call answers: the connector app says `authorizationUrl`, the entry's contract `redirectUrl`. */
const linkOf = (body: Record<string, unknown>) =>
  webUrl(body.authorizationUrl ?? body.redirectUrl ?? body.loginUrl);

const errorOf = (body: Record<string, unknown>, fallback: string) =>
  typeof body.message === "string" && body.message ? body.message : fallback;

/** A tab opened on the click itself, so a link that arrives later is not taken for a pop-up. */
export interface PendingTab {
  go(url: string): void;
  close(): void;
}

export function openPendingTab(): PendingTab | null {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  // The tab reaches Rome Cloud or the service, which must not reach back.
  tab.opener = null;
  return { go: (url) => void (tab.location.href = url), close: () => tab.close() };
}

/**
 * Signs the guardian in to the service's broker when the entry says it needs
 * that first. The sign-in answers a link and a key; the key's completion call
 * waits for the guardian to finish in the tab, so it is asked again while it
 * says they have not.
 */
async function signIn(
  login: { method: string; path: string },
  tab: PendingTab | null,
  signal: AbortSignal,
): Promise<void> {
  const start = apiPath(login.path);
  if (!start) throw new Error("This sign-in cannot start here");
  const started = await call(login.method, start);
  const url = linkOf(started.body);
  if (!started.ok || !url) throw new Error(errorOf(started.body, "Sign-in did not start"));
  tab?.go(url);
  const cliKey = started.body.cliKey;
  if (typeof cliKey !== "string") return;
  const complete = start.replace(/\/start$/, "/complete");
  const deadline = Date.now() + LOGIN_ATTEMPT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    const done = await call("POST", complete, { cliKey });
    if (done.ok) return;
    if (done.body.error !== "login_not_authorized") {
      throw new Error(errorOf(done.body, "Sign-in failed"));
    }
    await sleep(1000);
  }
  throw new Error("Sign-in timed out");
}

export type StartResult = { kind: "waiting" } | { kind: "connected" };

/**
 * Starts connecting a service from its entry. `tab` was opened on the click.
 * Resolves once the guardian has been sent where they connect it (`waiting`),
 * or when the service turns out to be connected already. Throws a short reason.
 */
export async function startConnect(
  connect: ConciergeConnectEntry,
  tab: PendingTab | null,
  signal: AbortSignal,
): Promise<StartResult> {
  switch (connect.kind) {
    case "rome_oauth": {
      const url = webUrl(connect.url);
      if (!connect.available || !url) throw new Error(connect.unavailableReason ?? "Unavailable");
      tab?.go(url);
      return { kind: "waiting" };
    }
    case "composio": {
      if (connect.needsLogin) await signIn(connect.login, tab, signal);
      const path = apiPath(connect.path);
      if (!path) throw new Error("This connection cannot start here");
      const started = await call(connect.method, path, connect.body);
      if (started.body.alreadyConnected === true) {
        tab?.close();
        return { kind: "connected" };
      }
      const url = linkOf(started.body);
      if (!started.ok || !url) {
        throw new Error(errorOf(started.body, "Connection did not start"));
      }
      tab?.go(url);
      return { kind: "waiting" };
    }
    case "dashboard":
      tab?.go(SETTINGS_CONNECTIONS_PATH);
      return { kind: "waiting" };
  }
}

/** The connector list's entry for `service` as it is now, or null when the list cannot be read or has none. */
export async function readConnector(service: string): Promise<ConciergeConnectorDto | null> {
  try {
    const res = await fetch("/api/concierge/connectors", {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const { connectors } = (await res.json()) as ConciergeConnectorsResponse;
    return connectors.find((entry) => entry.service === service) ?? null;
  } catch {
    return null;
  }
}

/** Whether `service` works now, by the Concierge's connector list. A failed read counts as not yet. */
export async function isServiceWorking(service: string): Promise<boolean> {
  return (await readConnector(service))?.state === "working";
}

/** Waits for `service` to work, for a bounded time. */
export async function waitForService(service: string, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < CONNECT_POLL_ATTEMPTS && !signal.aborted; attempt++) {
    await sleep(CONNECT_POLL_INTERVAL_MS);
    if (signal.aborted) return false;
    if (await isServiceWorking(service)) return true;
  }
  return false;
}

/** Tells the Concierge in `chatId` that `service` is connected, so it goes on. */
export async function notifyServiceConnected(chatId: string, service: string): Promise<void> {
  await call("POST", `/api/concierge/chats/${encodeURIComponent(chatId)}/service-connected`, {
    service,
  }).catch(() => {});
}
