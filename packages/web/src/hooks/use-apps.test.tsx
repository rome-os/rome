// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { useAppsList } from "./use-apps";

let urls: string[];

beforeEach(() => {
  urls = [];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ apps: [] }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("useAppsList", () => {
  it("reads the installed list once for every caller, and never asks Rome Cloud for updates", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const first = renderHook(() => useAppsList(), { wrapper });
    await waitFor(() => expect(first.result.current.apps).toEqual([]));
    // Another widget or tab icon mounting later reuses the list.
    renderHook(() => useAppsList(), { wrapper });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).toEqual(["/api/apps"]);
  });
});
