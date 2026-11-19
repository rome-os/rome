// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import type { InstalledAppCard } from "@rome/api-types/apps";
import { useAppsList } from "./use-apps";
import { allFeaturesShown, FEATURES_URL } from "@/test/features";

let urls: string[];

beforeEach(() => {
  urls = [];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL) => {
      if (String(input) === FEATURES_URL) return allFeaturesShown();
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

  describe("while a feature is hidden", () => {
    // `constructor` is an app id that names no feature, though every object
    // inherits a property by that name.
    const installed = [
      { id: "inbox" },
      { id: "notes" },
      { id: "constructor" },
    ] as InstalledAppCard[];

    function renderList(features: () => Promise<Response>) {
      rs.stubGlobal(
        "fetch",
        rs.fn(async (input: RequestInfo | URL) =>
          String(input) === FEATURES_URL ? features() : Response.json({ apps: installed }),
        ),
      );
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      return renderHook(() => useAppsList(), { wrapper });
    }

    it("leaves out the app of a hidden feature and keeps the rest", async () => {
      const { result } = renderList(async () =>
        Response.json({ features: { people: true, envoys: true, inbox: false } }),
      );
      await waitFor(() =>
        expect(result.current.apps?.map((app) => app.id)).toEqual(["notes", "constructor"]),
      );
    });

    it("holds back only the gated app until core says which features are shown", async () => {
      const { result } = renderList(() => new Promise<Response>(() => {}));
      await waitFor(() =>
        expect(result.current.apps?.map((app) => app.id)).toEqual(["notes", "constructor"]),
      );
    });
  });
});
