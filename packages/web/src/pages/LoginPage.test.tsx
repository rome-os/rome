// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderLogin(
  url: string,
  method: "cloud" | "local" = "cloud",
  dashboardVisitorAccess = true,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<AuthState>(AUTH_QUERY_KEY, {
    ready: true,
    backendReachable: true,
    bootstrap: {
      phase: "needs-signin",
      method,
      localPasswordAvailable: true,
      dashboardVisitorAccess,
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

    await screen.findByRole("button", { name: "Continue with Rome Cloud" });
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });

  it("does not start again after a failed attempt", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=cloud&cloud=error&reason=state");

    await screen.findByRole("alert");
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });

  function visitorStartCalls(fetchSpy: ReturnType<typeof stubCloudStart>): number {
    return fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/auth/visitor/start")
      .length;
  }

  it.each([
    "cloud",
    "local",
  ] as const)("starts the visitor sign-in once when a shared Rome is opened (%s)", async (method) => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=visitor", method);

    await waitFor(() => expect(visitorStartCalls(fetchSpy)).toBe(1));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(visitorStartCalls(fetchSpy)).toBe(1);
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });

  it("does not start the visitor sign-in again after it failed", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=visitor&visitor=error&reason=forbidden");

    await screen.findByRole("alert");
    expect(visitorStartCalls(fetchSpy)).toBe(0);
  });

  it("does not start the visitor sign-in on a box that lets no visitors in", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=visitor", "cloud", false);

    await screen.findByRole("button", { name: "Continue with Rome Cloud" });
    expect(visitorStartCalls(fetchSpy)).toBe(0);
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });

  it("keeps the cloud button busy while the visitor sign-in starts", async () => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((() => new Promise<Response>(() => {})) as typeof fetch);

    renderLogin("/login?via=visitor");

    const busy = await screen.findByRole("button", { name: "Opening Rome Cloud…" });
    fireEvent.click(busy);
    expect(
      fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/auth/cloud/start").length,
    ).toBe(0);
  });

  it("does not start on a local-first box", async () => {
    const fetchSpy = stubCloudStart();

    renderLogin("/login?via=cloud", "local");

    await screen.findByLabelText("Password");
    expect(cloudStartCalls(fetchSpy)).toBe(0);
  });
});

describe("use another account", () => {
  it("asks Rome Cloud to let the person choose an account", async () => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        (async () =>
          new Response(JSON.stringify({ error: "unavailable" }), { status: 503 })) as typeof fetch,
      );
    renderLogin("/login");

    fireEvent.click(screen.getByRole("button", { name: "Use another account" }));

    await screen.findByRole("alert");
    const starts = fetchSpy.mock.calls.filter(
      ([input]) => String(input) === "/api/auth/cloud/start",
    );
    expect(starts).toHaveLength(1);
    expect(JSON.parse(String(starts[0][1]?.body))).toEqual({ chooseAccount: true });
  });

  it.each([
    ["the main button", "Continue with Rome Cloud", "Use another account"],
    ["the link", "Use another account", "Continue with Rome Cloud"],
  ])("starts only one sign-in when %s is already starting", async (_, first, second) => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((() => new Promise<Response>(() => {})) as typeof fetch);
    renderLogin("/login");

    const secondControl = screen.getByRole("button", { name: second });
    fireEvent.click(screen.getByRole("button", { name: first }));
    await screen.findByRole("button", { name: "Opening Rome Cloud…" });
    fireEvent.click(secondControl);

    expect(
      fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/auth/cloud/start").length,
    ).toBe(1);
  });

  it("is not offered on a local-first box", () => {
    renderLogin("/login", "local");

    expect(screen.queryByRole("button", { name: "Use another account" })).toBeNull();
  });
});

describe("one sign-in method at a time", () => {
  it("swaps the cloud button and the local password form in place", () => {
    renderLogin("/login");

    expect(screen.getByRole("button", { name: "Continue with Rome Cloud" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use local password" }));
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with Rome Cloud" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use Rome Cloud" }));
    expect(screen.getByRole("button", { name: "Continue with Rome Cloud" })).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("ignores a second click while the cloud sign-in is starting", async () => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((() => new Promise<Response>(() => {})) as typeof fetch);
    renderLogin("/login");

    const button = screen.getByRole("button", { name: "Continue with Rome Cloud" });
    fireEvent.click(button);
    const busy = await screen.findByRole("button", { name: "Opening Rome Cloud…" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);

    expect(
      fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/auth/cloud/start").length,
    ).toBe(1);
  });

  it.each([
    "/login",
    "/login?via=cloud",
  ])("keeps a pending cloud start across a method swap (%s)", async (url) => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((() => new Promise<Response>(() => {})) as typeof fetch);
    renderLogin(url);

    if (url === "/login") {
      fireEvent.click(screen.getByRole("button", { name: "Continue with Rome Cloud" }));
    }
    await screen.findByRole("button", { name: "Opening Rome Cloud…" });

    fireEvent.click(screen.getByRole("button", { name: "Use local password" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Rome Cloud" }));

    const busy = await screen.findByRole("button", { name: "Opening Rome Cloud…" });
    fireEvent.click(busy);
    expect(
      fetchSpy.mock.calls.filter(([input]) => String(input) === "/api/auth/cloud/start").length,
    ).toBe(1);
  });
});

describe.each([
  {
    name: "visitor",
    method: "local",
    buttonLabel: "Open shared dashboard",
    endpoint: "/api/auth/visitor/start",
    startError: "Could not start shared dashboard sign-in. Please try again.",
  },
  {
    name: "cloud",
    method: "cloud",
    buttonLabel: "Continue with Rome Cloud",
    endpoint: "/api/auth/cloud/start",
    startError: "Could not start sign-in. Please try again.",
  },
] as const)("$name sign-in button", ({ method, buttonLabel, endpoint, startError }) => {
  it("starts once on rapid clicks and stays locked on success", async () => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    const fetchSpy = rs.spyOn(globalThis, "fetch").mockReturnValue(promise);
    renderLogin("/login", method);
    const button = screen.getByRole("button", { name: buttonLabel });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    await act(async () => resolve(Response.json({ authorizeUrl: window.location.href })));
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      endpoint,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("unlocks and allows retry after a start failure", async () => {
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockImplementation(async () => Response.json({ authorizeUrl: window.location.href }));
    renderLogin("/login", method);
    const button = screen.getByRole("button", { name: buttonLabel });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("alert").textContent).toBe(startError);
    expect(button.hasAttribute("aria-busy")).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
