// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import i18n from "@/i18n";
import AppEmbeddedPage from "./AppEmbeddedPage";

// The embedded-app-view seam (#1647): a catalog-change event for the open app
// refetches the manifest; an unchanged entry URL does not remount; a changed
// entry URL does; a 404 surfaces the error panel; and the stream is opened only
// for a guardian caller. All assertions are on externally observable behavior
// (whether a manifest fetch fired, which entry URL the host received, whether
// the host remounted, whether a stream connection was opened) — never internals.

// The real RomeAppHost dynamically imports the app bundle. We stub it with a
// component that mirrors the one behavior under test: it keys a mount counter on
// `entryUrl`, exactly as the real host keys its mount lifecycle on the entry URL.
// So `hostMounts.count` incrementing is a faithful proxy for "the host remounted".
const hostMounts = rs.hoisted(() => ({ count: 0, lastEntryUrl: "" }));

rs.mock("@/components/rome-app-host", () => {
  return {
    RomeAppHost: ({ entryUrl }: { entryUrl: string }) => {
      React.useEffect(() => {
        hostMounts.count += 1;
        hostMounts.lastEntryUrl = entryUrl;
      }, [entryUrl]);
      return React.createElement("div", {
        "data-testid": "app-host",
        "data-entry-url": entryUrl,
      });
    },
  };
});

rs.mock("@/hooks/use-theme", () => ({
  useTheme: () => ({ resolved: "light", theme: "ember" }),
}));

// Minimal in-memory EventSource so the guardian gate and the reconnect
// catch-up are drivable without a network. Tests read the constructed
// instances and dispatch `open` / `catalog-change` frames explicitly.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  private listeners = new Map<string, Set<(e: Event) => void>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: string): void {
    const event =
      type === "open" ? new Event("open") : new MessageEvent(type, { data: data ?? "" });
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
}

type CallerKind = "guardian" | "visitor" | "anonymous";

function manifestResponse(entryUrl: string, callerKind: CallerKind = "guardian"): Response {
  const caller =
    callerKind === "guardian"
      ? { kind: "guardian", userId: "u1" }
      : callerKind === "visitor"
        ? { kind: "visitor", accountId: "a1", email: "v@example.com" }
        : { kind: "anonymous" };
  const body = {
    appId: "demo",
    appName: "Demo",
    entryUrl,
    styleUrls: [],
    accessMode: "private",
    callerAccessAllowed: true,
    bootstrap: {
      appId: "demo",
      version: "1",
      routeBase: "/apps/demo",
      routePath: "",
      apiBase: "/api/apps/demo",
      assetBase: "/assets",
      shell: { theme: "light", themeName: "ember", mode: "embedded" },
      caller,
    },
  };
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function notFoundResponse(): Response {
  return {
    ok: false,
    status: 404,
    json: async () => ({ error: "App not found" }),
  } as unknown as Response;
}

// The current server truth for the manifest endpoint; each test rewires it.
let respond: () => Response;
let manifestFetches = 0;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  MockEventSource.instances = [];
  hostMounts.count = 0;
  hostMounts.lastEntryUrl = "";
  manifestFetches = 0;
  respond = () => manifestResponse("/assets/demo.v1.js");
  rs.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/apps/demo/manifest")) {
      manifestFetches += 1;
      return respond();
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  }) as typeof fetch);
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
});

function renderPage() {
  // A fresh QueryClient per render so no manifest cache leaks between tests;
  // retries off so a 404 surfaces immediately instead of being retried.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/apps/demo"]}>
        <Routes>
          <Route path="/apps/:appId/*" element={<AppEmbeddedPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stream(): MockEventSource {
  expect(MockEventSource.instances).toHaveLength(1);
  return MockEventSource.instances[0];
}

describe("AppEmbeddedPage catalog-change refresh", () => {
  it("opens the catalog stream only for a guardian caller", async () => {
    renderPage();
    await screen.findByTestId("app-host");

    // A guardian view opens exactly one connection to the guardian-gated route,
    // with credentials so the backend can resolve the session.
    const source = stream();
    expect(source.url).toBe("/api/apps/events");
    expect(source.withCredentials).toBe(true);
  });

  it("does not open a stream for a visitor caller", async () => {
    respond = () => manifestResponse("/assets/demo.v1.js", "visitor");
    renderPage();
    await screen.findByTestId("app-host");

    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("refetches the manifest on a catalog-change event for the open app", async () => {
    renderPage();
    await screen.findByTestId("app-host");
    expect(manifestFetches).toBe(1);

    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "changed" }));
    });

    await waitFor(() => expect(manifestFetches).toBe(2));
  });

  it("ignores a catalog-change event for a different app", async () => {
    renderPage();
    await screen.findByTestId("app-host");
    expect(manifestFetches).toBe(1);

    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "other", change: "changed" }));
    });

    // Give any errant refetch a chance to fire, then assert it did not.
    await Promise.resolve();
    expect(manifestFetches).toBe(1);
  });

  it("does not remount when the refetched entry URL is unchanged", async () => {
    renderPage();
    await screen.findByTestId("app-host");
    expect(hostMounts.count).toBe(1);

    // Server still reports the same entry URL (backend-only reinstall / no-op).
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "changed" }));
    });
    await waitFor(() => expect(manifestFetches).toBe(2));

    expect(hostMounts.count).toBe(1);
    expect(screen.getByTestId("app-host").getAttribute("data-entry-url")).toBe(
      "/assets/demo.v1.js",
    );
  });

  it("remounts against fresh assets when the refetched entry URL changed", async () => {
    renderPage();
    await screen.findByTestId("app-host");
    expect(hostMounts.count).toBe(1);

    respond = () => manifestResponse("/assets/demo.v2.js");
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "changed" }));
    });

    await waitFor(() =>
      expect(screen.getByTestId("app-host").getAttribute("data-entry-url")).toBe(
        "/assets/demo.v2.js",
      ),
    );
    expect(hostMounts.count).toBe(2);
  });

  it("surfaces the error panel when a refetch 404s (uninstall while open)", async () => {
    renderPage();
    await screen.findByTestId("app-host");

    respond = () => notFoundResponse();
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "removed" }));
    });

    await screen.findByText("App not found");
    expect(screen.queryByTestId("app-host")).toBeNull();
  });

  it("recovers live when an app is (re)installed after erroring while open", async () => {
    renderPage();
    await screen.findByTestId("app-host");

    // Uninstall while open → error panel, but the stream stays open (the
    // retained guardian manifest keeps the caller a guardian).
    respond = () => notFoundResponse();
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "removed" }));
    });
    await screen.findByText("App not found");

    // Reinstall → the same stream pokes a refetch → the view recovers.
    respond = () => manifestResponse("/assets/demo.v2.js");
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "added" }));
    });

    const host = await screen.findByTestId("app-host");
    expect(host.getAttribute("data-entry-url")).toBe("/assets/demo.v2.js");
    expect(screen.queryByText("App not found")).toBeNull();
  });

  it("ignores a stale refetch response that resolves out of order", async () => {
    // A single reinstall can emit several catalog-change events; each pokes a
    // refetch. If an earlier request's response lands after a later one's, it
    // must not clobber the fresher state. Drive manifest fetches through manual
    // deferrals so we control arrival order.
    const deferrals: Array<(r: Response) => void> = [];
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/apps/demo/manifest")) {
        manifestFetches += 1;
        return new Promise<Response>((resolve) => deferrals.push(resolve));
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch);

    renderPage();
    // Resolve the initial load with v1 so the guardian host mounts.
    await waitFor(() => expect(deferrals).toHaveLength(1));
    await act(async () => {
      deferrals[0](manifestResponse("/assets/demo.v1.js"));
    });
    await screen.findByTestId("app-host");

    // Two refetches in flight (reqA fired first, reqB second).
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "changed" }));
    });
    await waitFor(() => expect(deferrals).toHaveLength(2));
    act(() => {
      stream().emit("catalog-change", JSON.stringify({ appId: "demo", change: "changed" }));
    });
    await waitFor(() => expect(deferrals).toHaveLength(3));

    // The later request (reqB) resolves first with the fresh bundle…
    await act(async () => {
      deferrals[2](manifestResponse("/assets/demo.v3.js"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("app-host").getAttribute("data-entry-url")).toBe(
        "/assets/demo.v3.js",
      ),
    );

    // …then the earlier request (reqA) resolves late with stale data — it must
    // be ignored, leaving the view on the fresh bundle.
    await act(async () => {
      deferrals[1](manifestResponse("/assets/demo.v2.js"));
    });
    await Promise.resolve();
    expect(screen.getByTestId("app-host").getAttribute("data-entry-url")).toBe(
      "/assets/demo.v3.js",
    );
  });

  it("skips catch-up on the first connect but refetches on reconnect", async () => {
    renderPage();
    await screen.findByTestId("app-host");
    expect(manifestFetches).toBe(1);

    // The first `open` models the initial connect — the manifest was just
    // loaded, so there is nothing to catch up on and no second fetch fires.
    act(() => {
      stream().emit("open");
    });
    await Promise.resolve();
    expect(manifestFetches).toBe(1);

    // A genuine reconnect re-derives from the manifest so a change missed during
    // the blackout is reflected; a changed entry URL then remounts.
    respond = () => manifestResponse("/assets/demo.v2.js");
    act(() => {
      stream().emit("open");
    });

    await waitFor(() =>
      expect(screen.getByTestId("app-host").getAttribute("data-entry-url")).toBe(
        "/assets/demo.v2.js",
      ),
    );
    expect(manifestFetches).toBe(2);
  });
});
