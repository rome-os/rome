// @rstest-environment jsdom
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { FeatureVisibility } from "@rome/api-types/features";
import { FeatureGate, FeatureRoute } from "./feature-gate";
import { useBuiltinNav } from "@/shell/builtin-nav";

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function answer(features: FeatureVisibility | "error" | "never") {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/features") throw new Error(`unexpected fetch ${String(input)}`);
    if (features === "never") return new Promise<Response>(() => {});
    if (features === "error") return Response.json({ error: "nope" }, { status: 500 });
    return Response.json({ features });
  }) as typeof fetch);
}

function Providers({ children, path = "/" }: { children: ReactNode; path?: string }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ALL_HIDDEN: FeatureVisibility = { people: false, envoys: false, inbox: false };

describe("FeatureGate", () => {
  it("shows its children while the feature is shown", async () => {
    answer({ ...ALL_HIDDEN, people: true });
    render(
      <Providers>
        <FeatureGate feature="people" fallback={<p>hidden</p>}>
          <p>people</p>
        </FeatureGate>
      </Providers>,
    );
    expect(await screen.findByText("people")).toBeTruthy();
  });

  it("shows the fallback while the feature is hidden", async () => {
    answer(ALL_HIDDEN);
    render(
      <Providers>
        <FeatureGate feature="people" fallback={<p>hidden</p>}>
          <p>people</p>
        </FeatureGate>
      </Providers>,
    );
    expect(await screen.findByText("hidden")).toBeTruthy();
    expect(screen.queryByText("people")).toBeNull();
  });

  it("hides the feature when core cannot answer", async () => {
    answer("error");
    render(
      <Providers>
        <FeatureGate feature="inbox" fallback={<p>hidden</p>}>
          <p>inbox</p>
        </FeatureGate>
      </Providers>,
    );
    expect(await screen.findByText("hidden")).toBeTruthy();
  });

  it("renders nothing until core has answered", () => {
    answer("never");
    const { container } = render(
      <Providers>
        <FeatureGate feature="inbox" fallback={<p>hidden</p>}>
          <p>inbox</p>
        </FeatureGate>
      </Providers>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("FeatureRoute", () => {
  it("sends a hidden feature's address to the home page", async () => {
    answer(ALL_HIDDEN);
    render(
      <Providers path="/envoys">
        <Routes>
          <Route path="/" element={<p>home</p>} />
          <Route
            path="/envoys"
            element={
              <FeatureRoute feature="envoys">
                <p>envoys</p>
              </FeatureRoute>
            }
          />
        </Routes>
      </Providers>,
    );
    expect(await screen.findByText("home")).toBeTruthy();
  });
});

describe("useBuiltinNav", () => {
  it("leaves out the pages of hidden features", async () => {
    answer({ ...ALL_HIDDEN, envoys: true });
    const { result } = renderHook(() => useBuiltinNav(), {
      wrapper: ({ children }) => <Providers>{children}</Providers>,
    });
    await waitFor(() => expect(result.current.some((entry) => entry.id === "envoys")).toBe(true));
    const ids = result.current.map((entry) => entry.id);
    expect(ids).not.toContain("people");
    expect(ids).toContain("memory");
  });
});
