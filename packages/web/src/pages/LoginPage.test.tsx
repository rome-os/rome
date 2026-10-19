// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { AUTH_QUERY_KEY, type AuthState } from "@/lib/auth-state";
import LoginPage from "./LoginPage";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function renderLogin(url: string, method: "cloud" | "local" = "cloud") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<AuthState>(AUTH_QUERY_KEY, {
    ready: true,
    backendReachable: true,
    bootstrap: {
      phase: "needs-signin",
      method,
      localPasswordAvailable: true,
      dashboardVisitorAccess: true,
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <LoginPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("dashboard access error account", () => {
  it.each(["cloud", "local"] as const)("names the rejected account for %s sign-in", (method) => {
    renderLogin("/login?visitor=error&reason=forbidden#email=lin%2Bwork%40example.com", method);

    expect(screen.getByRole("alert").textContent).toContain(
      "You are signed in to Rome Cloud as lin+work@example.com.",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "ask its guardian to invite this email",
    );
  });

  it.each(["", "#email="])("keeps the generic message without an email (%s)", (hash) => {
    renderLogin(`/login?visitor=error&reason=forbidden${hash}`);

    expect(screen.getByRole("alert").textContent).toBe(
      "Your Rome Cloud email doesn't have access to this Rome. Ask its guardian to invite your email.",
    );
  });

  it("does not show the email for an unrelated failure", () => {
    renderLogin("/login?visitor=error&reason=expired#email=lin%40example.com");

    expect(screen.getByRole("alert").textContent).toBe(
      "The sign-in request timed out. Please try again.",
    );
    expect(screen.queryByText(/lin@example.com/)).toBeNull();
  });

  it("does not show an account without a visitor failure", () => {
    renderLogin("/login#email=lin%40example.com");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/lin@example.com/)).toBeNull();
  });

  it("renders account text without interpreting markup", () => {
    const email = '<img src=x onerror="alert(1)">@example.com';
    const { container } = renderLogin(
      `/login?visitor=error&reason=forbidden#email=${encodeURIComponent(email)}`,
    );

    expect(screen.getByRole("alert").textContent).toContain(email);
    expect(container.querySelector("img")).toBeNull();
  });

  it("localizes the account message in Chinese", async () => {
    await i18n.changeLanguage("zh-CN");
    renderLogin("/login?visitor=error&reason=forbidden#email=lin%40example.com");

    expect(screen.getByRole("alert").textContent).toContain(
      "你当前登录 Rome Cloud 的账号是 lin@example.com",
    );
  });
});

describe("auto sign-in from Rome Cloud", () => {
  // Rome Cloud refuses the start here so the page stays put: a refused start
  // is the only outcome that does not navigate away.
  function stubCloudStart() {
    return rs
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (async () =>
          new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })) as typeof fetch,
      );
  }

  function cloudStartCalls(fetchSpy: ReturnType<typeof stubCloudStart>): number {
    return fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/auth/cloud/start")
      .length;
  }

  it("starts the cloud sign-in once when opened from Rome Cloud", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=cloud");

    await waitFor(() => expect(cloudStartCalls(fetchSpy)).toBe(1));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(cloudStartCalls(fetchSpy)).toBe(1);
  });

  it("waits for the click without the hint", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login");

    await screen.findByRole("button", { name: "Sign in with Rome Cloud" });
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });

  it("does not start again after a failed attempt", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=cloud&cloud=error&reason=state");

    await screen.findByRole("alert");
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });

  it("does not start on a local-first box", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=cloud", "local");

    await screen.findByLabelText("Password");
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });
});
