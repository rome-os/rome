import { describe, expect, it, rs } from "@rstest/core";
import { fetchAuthState, hasSession } from "@/lib/auth-state";

type Fetcher = typeof fetch;

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    ...init,
  } as unknown as Response;
}

function notOkResponse(status = 502): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

function makeFetcher(handler: (path: string) => Response | Promise<Response>): Fetcher {
  return rs.fn(async (input: RequestInfo | URL) => handler(String(input))) as unknown as Fetcher;
}

describe("fetchAuthState", () => {
  it("flags backendReachable=false when /api/health throws (e.g. ECONNREFUSED)", async () => {
    const fetcher = rs.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/health") throw new TypeError("Failed to fetch");
      return jsonResponse({});
    }) as unknown as Fetcher;

    const state = await fetchAuthState({ fetcher });

    expect(state.ready).toBe(true);
    expect(state.backendReachable).toBe(false);
    expect(state.bootstrap).toBeNull();
  });

  it("flags backendReachable=false when /api/health returns 502", async () => {
    const fetcher = makeFetcher((path) =>
      path === "/api/health" ? notOkResponse(502) : jsonResponse({ phase: "ready" }),
    );

    const state = await fetchAuthState({ fetcher });

    expect(state.backendReachable).toBe(false);
  });

  it("returns the bootstrap state when health and bootstrap both succeed", async () => {
    const fetcher = makeFetcher((path) => {
      if (path === "/api/health") return jsonResponse({ status: "ok" });
      if (path === "/api/bootstrap") return jsonResponse({ phase: "ready" });
      throw new Error(`unexpected fetch: ${path}`);
    });

    const state = await fetchAuthState({ fetcher });

    expect(state).toEqual({
      ready: true,
      backendReachable: true,
      bootstrap: { phase: "ready" },
    });
  });

  it("carries the needs-signin payload through verbatim", async () => {
    const fetcher = makeFetcher((path) => {
      if (path === "/api/health") return jsonResponse({ status: "ok" });
      if (path === "/api/bootstrap")
        return jsonResponse({
          phase: "needs-signin",
          method: "cloud",
          localPasswordAvailable: false,
        });
      throw new Error(`unexpected fetch: ${path}`);
    });

    const state = await fetchAuthState({ fetcher });

    expect(state.bootstrap).toEqual({
      phase: "needs-signin",
      method: "cloud",
      localPasswordAvailable: false,
    });
  });

  it("flags backendReachable=false when /api/bootstrap throws after a healthy probe", async () => {
    const fetcher = rs.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/health") return jsonResponse({ status: "ok" });
      throw new TypeError("Failed to fetch");
    }) as unknown as Fetcher;

    const state = await fetchAuthState({ fetcher });

    expect(state.backendReachable).toBe(false);
    expect(state.bootstrap).toBeNull();
  });

  it("flags backendReachable=false when /api/bootstrap returns non-2xx", async () => {
    const fetcher = makeFetcher((path) =>
      path === "/api/health" ? jsonResponse({ status: "ok" }) : notOkResponse(500),
    );

    const state = await fetchAuthState({ fetcher });

    expect(state.backendReachable).toBe(false);
  });

  it("flags backendReachable=false when /api/bootstrap returns non-JSON 200", async () => {
    const fetcher = makeFetcher((path) => {
      if (path === "/api/health") return jsonResponse({ status: "ok" });
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      } as unknown as Response;
    });

    const state = await fetchAuthState({ fetcher });

    expect(state.backendReachable).toBe(false);
  });

  it("does not send credentials with the health probe", async () => {
    const fetcher = rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/health") {
        expect(init?.credentials).toBeUndefined();
        return jsonResponse({ status: "ok" });
      }
      return jsonResponse({ phase: "ready" });
    }) as unknown as Fetcher;

    await fetchAuthState({ fetcher });

    expect(fetcher).toHaveBeenCalled();
  });

  it("threads the AbortSignal through both fetch calls (health + bootstrap only)", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const fetcher = rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init?.signal ?? undefined);
      if (String(input) === "/api/health") return jsonResponse({ status: "ok" });
      return jsonResponse({ phase: "ready" });
    }) as unknown as Fetcher;

    await fetchAuthState({ fetcher, signal: controller.signal });

    expect(seen).toHaveLength(2);
    seen.forEach((s) => expect(s).toBe(controller.signal));
  });
});

describe("hasSession", () => {
  it("is true for the post-sign-in phases", () => {
    expect(hasSession({ phase: "needs-onboarding" })).toBe(true);
    expect(hasSession({ phase: "ready" })).toBe(true);
  });

  it("is false for the pre-sign-in phases and null", () => {
    expect(hasSession({ phase: "unenrolled" })).toBe(false);
    expect(hasSession({ phase: "needs-account" })).toBe(false);
    expect(hasSession({ phase: "needs-signin", method: "local" })).toBe(false);
    expect(hasSession(null)).toBe(false);
  });
});
