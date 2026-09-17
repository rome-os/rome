// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  APP_LAST_OPENED_STORAGE_KEY,
  useAppLastOpened,
  useRecordAppOpened,
} from "./use-recent-apps";

let serverSettings: Record<string, unknown> = {};

const fetchMock = rs.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  if (url === "/api/settings" && (!init?.method || init.method === "GET")) {
    return new Response(JSON.stringify(serverSettings), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url === "/api/settings" && init?.method === "PUT") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(null, { status: 404 });
});

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function putBodies(): Array<Record<string, Record<string, string>>> {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

beforeEach(() => {
  serverSettings = {};
  fetchMock.mockClear();
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("useRecordAppOpened", () => {
  it("writes the open to settings and the local mirror for a guardian", async () => {
    renderHook(() => useRecordAppOpened("recipe-box", true), { wrapper });

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    const written = putBodies()[0].appLastOpened;
    expect(Object.keys(written)).toEqual(["recipe-box"]);
    expect(Number.isNaN(Date.parse(written["recipe-box"]))).toBe(false);
    expect(JSON.parse(localStorage.getItem(APP_LAST_OPENED_STORAGE_KEY) ?? "{}")).toEqual(written);
  });

  it("does nothing, and never asks for settings, when disabled", async () => {
    renderHook(() => useRecordAppOpened("recipe-box", false), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(APP_LAST_OPENED_STORAGE_KEY)).toBeNull();
  });

  it("merges with the server's map instead of clobbering another device's entry", async () => {
    const other = new Date(Date.now() - 60_000).toISOString();
    serverSettings = { appLastOpened: { "other-app": other } };

    renderHook(() => useRecordAppOpened("recipe-box", true), { wrapper });

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0].appLastOpened["other-app"]).toBe(other);
    expect(putBodies()[0].appLastOpened["recipe-box"]).toBeDefined();
  });

  it("skips the write when this app is already the newest, fresh entry", async () => {
    const justNow = new Date(Date.now() - 5_000).toISOString();
    serverSettings = { appLastOpened: { "recipe-box": justNow } };

    renderHook(() => useRecordAppOpened("recipe-box", true), { wrapper });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings", expect.anything()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(putBodies()).toHaveLength(0);
  });
});

describe("useAppLastOpened", () => {
  it("starts from the local mirror and folds in the server's newer values", async () => {
    const local = new Date(Date.now() - 120_000).toISOString();
    const server = new Date(Date.now() - 60_000).toISOString();
    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: local }));
    serverSettings = { appLastOpened: { a: server, b: server } };

    const { result } = renderHook(() => useAppLastOpened(), { wrapper });

    expect(result.current).toEqual({ a: local });
    await waitFor(() => expect(result.current).toEqual({ a: server, b: server }));
  });

  it("re-reads the mirror when another part of the page records an open", async () => {
    const { result } = renderHook(() => useAppLastOpened(), { wrapper });
    const opened = new Date().toISOString();

    localStorage.setItem(APP_LAST_OPENED_STORAGE_KEY, JSON.stringify({ a: opened }));
    window.dispatchEvent(new Event("rome-app-opened"));

    await waitFor(() => expect(result.current).toEqual({ a: opened }));
  });
});
