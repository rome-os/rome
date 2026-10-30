import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient } from "@tanstack/react-query";
import { CHAT_PAGE_TURNS, CONCIERGE_PAGE_TURNS } from "@/components/chat/use-older-messages";
import { settingsQueryOptions } from "@/hooks/use-settings";
import { AUTH_QUERY_KEY, fetchAuthState } from "./auth-state";
import { getSession, listSessionMessagePage } from "./chat-api";
import { chatSessionIdFromPath, isChatPath, startEntryPrefetch } from "./entry-prefetch";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubApi(overrides: Record<string, () => Response> = {}) {
  return rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const hit = Object.entries(overrides).find(([prefix]) => url.startsWith(prefix));
    if (hit) return hit[1]();
    if (url === "/api/health") return json({ status: "ok" });
    if (url === "/api/bootstrap") return json({ phase: "ready" });
    if (url === "/api/settings") return json({ experimentalConcierge: true });
    if (url.startsWith("/api/chat/sessions/") && url.includes("/messages")) {
      return json({ messages: [], nextCursor: null });
    }
    if (url.startsWith("/api/chat/sessions/")) return json({ id: "s", name: "S" });
    return json({});
  });
}

const callsTo = (spy: ReturnType<typeof stubApi>, needle: string) =>
  spy.mock.calls.filter(([input]) => String(input).includes(needle));

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  rs.restoreAllMocks();
});

describe("chatSessionIdFromPath / isChatPath", () => {
  it("reads the session id from /chat/<id>", () => {
    expect(chatSessionIdFromPath("/chat/concierge")).toBe("concierge");
    expect(chatSessionIdFromPath("/chat/abc-123/extra")).toBe("abc-123");
    expect(chatSessionIdFromPath("/chat/a%20b")).toBe("a b");
  });

  it("finds no session on the chat home, a draft or another route", () => {
    expect(chatSessionIdFromPath("/chat")).toBeNull();
    expect(chatSessionIdFromPath("/chat/new")).toBeNull();
    expect(chatSessionIdFromPath("/settings/chat/x")).toBeNull();
    expect(chatSessionIdFromPath("/chat/%E0%A4%A")).toBeNull();
  });

  it("treats / and everything under /chat as the chat route", () => {
    for (const path of ["/", "/chat", "/chat/x"]) expect(isChatPath(path)).toBe(true);
    for (const path of ["/login", "/chatter", "/settings", "/share/t"]) {
      expect(isChatPath(path)).toBe(false);
    }
  });
});

describe("startEntryPrefetch", () => {
  it("fills the caches the app reads, under the keys it reads them with", async () => {
    stubApi();
    startEntryPrefetch("/settings", client, () => Promise.resolve());
    await rs.waitFor(() => expect(client.getQueryData(AUTH_QUERY_KEY)).toBeDefined());
    await rs.waitFor(() =>
      expect(client.getQueryData(settingsQueryOptions.queryKey)).toBeDefined(),
    );
    expect(client.getQueryData(AUTH_QUERY_KEY)).toEqual(
      expect.objectContaining({ ready: true, backendReachable: true }),
    );
    expect(client.getQueryData(["settings"])).toEqual({ experimentalConcierge: true });
  });

  it("stores exactly what the auth gate's own fetcher returns", async () => {
    stubApi();
    startEntryPrefetch("/login", client, () => Promise.resolve());
    await rs.waitFor(() => expect(client.getQueryData(AUTH_QUERY_KEY)).toBeDefined());
    expect(client.getQueryData(AUTH_QUERY_KEY)).toEqual(await fetchAuthState());
  });

  it("loads the chat route and the open session's reads on a chat address", async () => {
    const spy = stubApi();
    const loadChat = rs.fn(() => Promise.resolve());
    startEntryPrefetch("/chat/prefetch-a", client, loadChat);
    expect(loadChat).toHaveBeenCalledTimes(1);
    await rs.waitFor(() =>
      expect(callsTo(spy, "/api/chat/sessions/prefetch-a/messages")).toHaveLength(1),
    );
    expect(callsTo(spy, "/api/chat/sessions/prefetch-a")).toHaveLength(2);
  });

  it("lets the chat's own reads adopt the prefetched ones instead of repeating them", async () => {
    const spy = stubApi();
    startEntryPrefetch("/chat/prefetch-b", client, () => Promise.resolve());
    const before = spy.mock.calls.length;
    await getSession("prefetch-b");
    await listSessionMessagePage("prefetch-b", { limit: CHAT_PAGE_TURNS });
    expect(spy.mock.calls.length).toBe(before);
  });

  it("asks for the Concierge page size on the Concierge chat and the ordinary one elsewhere", async () => {
    const spy = stubApi();
    startEntryPrefetch("/chat/concierge", client, () => Promise.resolve());
    startEntryPrefetch("/chat/prefetch-c", client, () => Promise.resolve());
    const urls = spy.mock.calls.map(([input]) => String(input));
    expect(urls).toContain(`/api/chat/sessions/concierge/messages?limit=${CONCIERGE_PAGE_TURNS}`);
    expect(urls).toContain(`/api/chat/sessions/prefetch-c/messages?limit=${CHAT_PAGE_TURNS}`);
    expect(CONCIERGE_PAGE_TURNS).not.toBe(CHAT_PAGE_TURNS);
  });

  it("does not read a session on the chat home, a draft, or another route", async () => {
    const spy = stubApi();
    const loadChat = rs.fn(() => Promise.resolve());
    startEntryPrefetch("/chat", client, loadChat);
    startEntryPrefetch("/chat/new", client, loadChat);
    expect(loadChat).toHaveBeenCalledTimes(2);
    startEntryPrefetch("/people", client, loadChat);
    expect(loadChat).toHaveBeenCalledTimes(2);
    expect(callsTo(spy, "/api/chat/sessions")).toHaveLength(0);
  });

  it("leaves the auth flow alone when the visitor is signed out", async () => {
    const spy = stubApi({
      "/api/bootstrap": () => json({ phase: "needs-signin" }),
      "/api/chat/sessions/": () => json({ error: "unauthorized" }, 401),
    });
    expect(() =>
      startEntryPrefetch("/chat/prefetch-d", client, () => Promise.reject(new Error("offline"))),
    ).not.toThrow();
    await rs.waitFor(() =>
      expect(client.getQueryData(AUTH_QUERY_KEY)).toEqual(
        expect.objectContaining({ bootstrap: { phase: "needs-signin" } }),
      ),
    );
    // The failed prefetch is dropped, so the chat that mounts after sign-in asks again
    // and sees the real answer rather than a stale 401.
    const afterPrefetch = callsTo(spy, "/api/chat/sessions/prefetch-d").length;
    await expect(
      listSessionMessagePage("prefetch-d", { limit: CHAT_PAGE_TURNS }),
    ).rejects.toThrow();
    expect(callsTo(spy, "/api/chat/sessions/prefetch-d").length).toBe(afterPrefetch + 1);
  });
});

describe("primed reads", () => {
  it("serves a primed page once, then reads fresh data", async () => {
    const spy = stubApi();
    startEntryPrefetch("/chat/prefetch-e", client, () => Promise.resolve());
    await listSessionMessagePage("prefetch-e", { limit: CHAT_PAGE_TURNS });
    const afterFirst = spy.mock.calls.length;
    // Past the share window a repeat read is a refresh and must hit the server.
    rs.useFakeTimers();
    rs.advanceTimersByTime(1_500);
    await listSessionMessagePage("prefetch-e", { limit: CHAT_PAGE_TURNS });
    rs.useRealTimers();
    expect(spy.mock.calls.length).toBe(afterFirst + 1);
  });

  it("never serves a primed page for an older-page request", async () => {
    const spy = stubApi();
    startEntryPrefetch("/chat/prefetch-f", client, () => Promise.resolve());
    const before = spy.mock.calls.length;
    await listSessionMessagePage("prefetch-f", { limit: CHAT_PAGE_TURNS, before: "cursor-1" });
    expect(spy.mock.calls.length).toBe(before + 1);
    expect(String(spy.mock.calls.at(-1)?.[0])).toContain("before=cursor-1");
  });

  it("does not serve a primed page for a different page size", async () => {
    const spy = stubApi();
    startEntryPrefetch("/chat/prefetch-g", client, () => Promise.resolve());
    const before = spy.mock.calls.length;
    await listSessionMessagePage("prefetch-g", { limit: CHAT_PAGE_TURNS + 1 });
    expect(spy.mock.calls.length).toBe(before + 1);
  });
});
