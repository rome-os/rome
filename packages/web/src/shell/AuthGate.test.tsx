// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { useEffect } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { AuthGate } from "./AuthGate";

// `AuthGate` used to be keyed on `location.pathname`, so every in-app
// `navigate(...)` triggered a fresh bootstrap round trip per click. The fix is to
// back auth state with a react-query query that refetches only on mount /
// explicit invalidation / a polling interval when the backend is unreachable.
// This test pins that contract: navigating between routes must not call `fetch`
// again. The /api/health + /api/bootstrap phase folds in session and onboarding
// state.

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function Navigator({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to);
  }, [navigate, to]);
  return null;
}

function makeFetchSpy() {
  return rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url === "/api/bootstrap") {
      return new Response(JSON.stringify({ phase: "ready" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}

describe("AuthGate auth-state refetch contract", () => {
  it("calls /api/health + /api/bootstrap exactly once across multiple navigations", async () => {
    const fetchSpy = makeFetchSpy();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/"]}>
          <AuthGate>
            <>
              <Navigator to="/projects/foo" />
              <div>content</div>
            </>
          </AuthGate>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/bootstrap"),
      ).toHaveLength(1);
    });

    // Drive a few more navigations through the same AuthGate.
    for (const target of ["/memory/bar", "/projects/baz", "/"]) {
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/"]}>
            <AuthGate>
              <Navigator to={target} />
            </AuthGate>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The cache backs every AuthGate instance, so the auth-state probe still
    // fires exactly once across all navigations.
    const healthCalls = fetchSpy.mock.calls.filter(([i]) => String(i) === "/api/health");
    const bootstrapCalls = fetchSpy.mock.calls.filter(([i]) => String(i) === "/api/bootstrap");
    expect(healthCalls).toHaveLength(1);
    expect(bootstrapCalls).toHaveLength(1);
  });
});
