// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { ConciergeConnectEntry } from "@rome/api-types/concierge";
import {
  isServiceWorking,
  readConnector,
  notifyServiceConnected,
  startConnect,
  type PendingTab,
} from "./connect-card";

afterEach(() => rs.restoreAllMocks());

const signal = new AbortController().signal;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers each call from a table keyed by `METHOD path`, and records the calls. */
function mockApi(routes: Record<string, () => Response>) {
  const calls: { key: string; body: unknown }[] = [];
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[key];
    return route ? route() : reply({ error: "nope" }, 404);
  }) as typeof fetch);
  return calls;
}

function fakeTab() {
  const opened: string[] = [];
  let closed = false;
  const tab: PendingTab = { go: (url) => opened.push(url), close: () => (closed = true) };
  return { tab, opened, wasClosed: () => closed };
}

const COMPOSIO = (needsLogin: boolean): ConciergeConnectEntry => ({
  kind: "composio",
  method: "POST",
  path: "/api/apps/connector/connectors",
  body: { provider: "mail" },
  needsLogin,
  login: { method: "POST", path: "/api/apps/connector/login/start" },
});

describe("startConnect", () => {
  it("opens a Rome Cloud sign-in url in the tab", async () => {
    const { tab, opened } = fakeTab();
    await expect(
      startConnect(
        {
          kind: "rome_oauth",
          url: "https://cloud.test/connect/code",
          available: true,
          unavailableReason: null,
        },
        tab,
        signal,
      ),
    ).resolves.toEqual({ kind: "waiting" });
    expect(opened).toEqual(["https://cloud.test/connect/code"]);
  });

  it("says why a Rome Cloud sign-in is unavailable, and opens nothing", async () => {
    const { tab, opened } = fakeTab();
    await expect(
      startConnect(
        { kind: "rome_oauth", url: null, available: false, unavailableReason: "Not set up" },
        tab,
        signal,
      ),
    ).rejects.toThrow("Not set up");
    expect(opened).toEqual([]);
  });

  it("refuses a link that is not a web address", async () => {
    const { tab, opened } = fakeTab();
    await expect(
      startConnect(
        {
          kind: "rome_oauth",
          url: "javascript:alert(1)",
          available: true,
          unavailableReason: null,
        },
        tab,
        signal,
      ),
    ).rejects.toThrow();
    expect(opened).toEqual([]);
  });

  it("calls the entry's own request and opens the link it answers", async () => {
    const calls = mockApi({
      "POST /api/apps/connector/connectors": () =>
        reply({ authorizationUrl: "https://composio.test/auth" }),
    });
    const { tab, opened } = fakeTab();

    await expect(startConnect(COMPOSIO(false), tab, signal)).resolves.toEqual({ kind: "waiting" });

    expect(calls).toEqual([
      { key: "POST /api/apps/connector/connectors", body: { provider: "mail" } },
    ]);
    expect(opened).toEqual(["https://composio.test/auth"]);
  });

  it("reads the link as redirectUrl too, as the entry's contract names it", async () => {
    mockApi({
      "POST /api/apps/connector/connectors": () =>
        reply({ redirectUrl: "https://composio.test/r" }),
    });
    const { tab, opened } = fakeTab();

    await startConnect(COMPOSIO(false), tab, signal);

    expect(opened).toEqual(["https://composio.test/r"]);
  });

  it("is connected, with no tab left open, when the service already was", async () => {
    mockApi({ "POST /api/apps/connector/connectors": () => reply({ alreadyConnected: true }) });
    const { tab, wasClosed, opened } = fakeTab();

    await expect(startConnect(COMPOSIO(false), tab, signal)).resolves.toEqual({
      kind: "connected",
    });
    expect(wasClosed()).toBe(true);
    expect(opened).toEqual([]);
  });

  it("signs in first when the entry says so, waiting while the guardian has not finished", async () => {
    let completes = 0;
    const calls = mockApi({
      "POST /api/apps/connector/login/start": () =>
        reply({ loginUrl: "https://composio.test/login", cliKey: "key-12345678" }),
      "POST /api/apps/connector/login/complete": () =>
        ++completes < 2 ? reply({ error: "login_not_authorized" }, 409) : reply({ ok: true }),
      "POST /api/apps/connector/connectors": () =>
        reply({ authorizationUrl: "https://composio.test/auth" }),
    });
    const { tab, opened } = fakeTab();
    rs.useFakeTimers();
    const started = startConnect(COMPOSIO(true), tab, signal);
    await rs.advanceTimersByTimeAsync(5000);
    rs.useRealTimers();

    await expect(started).resolves.toEqual({ kind: "waiting" });
    expect(opened).toEqual(["https://composio.test/login", "https://composio.test/auth"]);
    expect(calls.map((call) => call.key)).toEqual([
      "POST /api/apps/connector/login/start",
      "POST /api/apps/connector/login/complete",
      "POST /api/apps/connector/login/complete",
      "POST /api/apps/connector/connectors",
    ]);
    expect(calls[1].body).toEqual({ cliKey: "key-12345678" });
  });

  it("stops at a sign-in that failed, with the reason it gave", async () => {
    mockApi({
      "POST /api/apps/connector/login/start": () =>
        reply({ loginUrl: "https://composio.test/login", cliKey: "key-12345678" }),
      "POST /api/apps/connector/login/complete": () =>
        reply({ error: "authentication_failed", message: "Sign-in failed" }, 401),
    });
    const { tab } = fakeTab();

    await expect(startConnect(COMPOSIO(true), tab, signal)).rejects.toThrow("Sign-in failed");
  });

  it("calls only paths on this Rome's own API", async () => {
    const calls = mockApi({});
    const { tab } = fakeTab();

    await expect(
      startConnect(
        { ...(COMPOSIO(false) as object), path: "https://evil.test/x" } as ConciergeConnectEntry,
        tab,
        signal,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("sends the guardian to Settings for a service only Settings connects", async () => {
    const { tab, opened } = fakeTab();

    await expect(startConnect({ kind: "dashboard" }, tab, signal)).resolves.toEqual({
      kind: "waiting",
    });
    expect(opened).toEqual(["/settings/connections"]);
  });
});

describe("readConnector", () => {
  it("answers the service's entry in the list as it is now", async () => {
    mockApi({
      "GET /api/concierge/connectors": () =>
        reply({
          connectors: [
            { service: "code", state: "broken", connect: { kind: "dashboard" } },
            { service: "mail", state: null, connect: { kind: "dashboard" } },
          ],
          rules: {},
        }),
    });

    expect(await readConnector("mail")).toMatchObject({ service: "mail", state: null });
    expect(await readConnector("fax")).toBeNull();
  });

  it("answers null when the list cannot be read", async () => {
    mockApi({ "GET /api/concierge/connectors": () => reply({}, 502) });
    expect(await readConnector("mail")).toBeNull();
    rs.restoreAllMocks();
    rs.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await readConnector("mail")).toBeNull();
  });
});

describe("isServiceWorking", () => {
  const list = (connectors: object[]) => () => reply({ connectors, rules: {} });

  it("reads the Concierge's connector list", async () => {
    mockApi({
      "GET /api/concierge/connectors": list([
        { service: "mail", state: "working" },
        { service: "code", state: "broken" },
        { service: "chat", state: null },
      ]),
    });

    expect(await isServiceWorking("mail")).toBe(true);
    expect(await isServiceWorking("code")).toBe(false);
    expect(await isServiceWorking("chat")).toBe(false);
    expect(await isServiceWorking("fax")).toBe(false);
  });

  it("counts a failed read as not yet", async () => {
    mockApi({ "GET /api/concierge/connectors": () => reply({}, 502) });
    expect(await isServiceWorking("mail")).toBe(false);
    rs.restoreAllMocks();
    rs.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    expect(await isServiceWorking("mail")).toBe(false);
  });
});

describe("notifyServiceConnected", () => {
  it("posts the service to the chat's own route", async () => {
    const calls = mockApi({
      "POST /api/concierge/chats/topic%201/service-connected": () =>
        new Response(null, { status: 202 }),
    });

    await notifyServiceConnected("topic 1", "mail");

    expect(calls).toEqual([
      { key: "POST /api/concierge/chats/topic%201/service-connected", body: { service: "mail" } },
    ]);
  });

  it("never throws", async () => {
    rs.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(notifyServiceConnected("c", "mail")).resolves.toBeUndefined();
  });
});
