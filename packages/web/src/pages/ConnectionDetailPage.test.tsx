// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import ConnectionDetailPage from "@/pages/ConnectionDetailPage";
import type { ApiConnection, GrantDisplay, GrantState } from "@/lib/connections-api";
import type { ComposioCliStatus } from "@/lib/provider-types";

/** A later account's channel id, opaque as core mints it. */
const SECOND_FEISHU = "c7d1a0e2-5b3f-4e8a-9c61-2f0b7d4e8a13";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function connection(
  overrides: Partial<ApiConnection> & Pick<ApiConnection, "service">,
): ApiConnection {
  return {
    id: `conn-${overrides.service}`,
    label: overrides.service,
    grants: {},
    display: {},
    capabilities: {
      talk: { state: "unsupported" },
      act: { state: "unsupported" },
      watch: { state: "unsupported" },
    },
    connect: null,
    setups: {},
    channel: null,
    severalAccounts: false,
    ...overrides,
  };
}

function oauth(
  service: "github" | "google",
  state: GrantState = "unauthorized",
  display: GrantDisplay | null = null,
): ApiConnection {
  return connection({
    service,
    grants: { user: state },
    display: { user: display },
    connect: { url: `https://oauth/${service}`, available: true, unavailableReason: null },
  });
}

/** Mirrors the old minimal channel-status fold: telegram + whatsapp offered but
 *  unconnected, webchat always on. */
function minimalConnections(): ApiConnection[] {
  return [
    connection({ service: "telegram", grants: { bot: "unauthorized" } }),
    connection({ service: "whatsapp", grants: { session: "unauthorized" } }),
    connection({ service: "webchat" }),
  ];
}

function mockApi(
  connections: ApiConnection[] = minimalConnections(),
  composio: ComposioCliStatus | null = null,
) {
  rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/connections") {
      return new Response(JSON.stringify({ connections }), { status: 200 });
    }
    if (url === "/api/integrations/composio/status") {
      return new Response(JSON.stringify({ composio }), { status: 200 });
    }
    // Ceremony cards self-fetch their transient status; minimal ok JSON is
    // enough when the ceremony state isn't the assertion target.
    return new Response("{}", { status: 200 });
  });
}

/** Records the location the page renders at, so redirect tests can assert navigation. */
function LocationCapture({ onLocation }: { onLocation: (path: string) => void }) {
  const location = useLocation();
  onLocation(location.pathname);
  return null;
}

function renderDetail(serviceId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const locations: string[] = [];

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/settings/connections/${serviceId}`]}>
        <Routes>
          <Route path="/settings/connections/:serviceId" element={<ConnectionDetailPage />} />
          <Route
            path="/settings/connections"
            element={<LocationCapture onLocation={(p) => locations.push(p)} />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { locations };
}

describe("ConnectionDetailPage — unknown serviceId redirects", () => {
  it("navigates back to the list when the serviceId has no matching connection", async () => {
    mockApi();
    const { locations } = renderDetail("not-a-real-service");

    await waitFor(() => {
      expect(locations).toContain("/settings/connections");
    });
  });

  it("redirects the retired telegram-user route to the merged Telegram detail", async () => {
    // The personal account folded onto the Telegram connection as a slot; its old
    // standalone route now redirects to /settings/connections/telegram.
    mockApi();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const locations: string[] = [];

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/settings/connections/telegram-user"]}>
          <Routes>
            <Route path="/settings/connections/:serviceId" element={<ConnectionDetailPage />} />
            <Route
              path="/settings/connections/telegram"
              element={<LocationCapture onLocation={(p) => locations.push(p)} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(locations).toContain("/settings/connections/telegram");
    });
  });
});

describe("ConnectionDetailPage — load failure", () => {
  it("stays on the detail route and retries the connections request", async () => {
    let connectionRequests = 0;
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/connections") {
        connectionRequests += 1;
        if (connectionRequests === 1) {
          return new Response("", { status: 503 });
        }
        return new Response(
          JSON.stringify({ connections: [...minimalConnections(), oauth("github")] }),
          { status: 200 },
        );
      }
      if (url === "/api/integrations/composio/status") {
        return new Response(JSON.stringify({ composio: null }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });

    const { locations } = renderDetail("github");

    expect((await screen.findByRole("alert")).textContent).toContain("Failed to load connections.");
    expect(locations).not.toContain("/settings/connections");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "Connect" })).toBeTruthy();
    expect(connectionRequests).toBe(2);
  });
});

describe("ConnectionDetailPage — webchat (alwaysOn)", () => {
  it("shows the Always on note in the Connection section", async () => {
    mockApi();
    renderDetail("webchat");

    expect(await screen.findByText("Always on — nothing to configure.")).toBeTruthy();
  });

  it("renders the plain enablement bullet for webchat", async () => {
    mockApi();
    renderDetail("webchat");

    expect(
      await screen.findByText("Chat with your agent right here in the dashboard"),
    ).toBeTruthy();
  });

  it("shows plain enablement copy without the Talk/Act/Watch taxonomy", async () => {
    mockApi();
    renderDetail("webchat");

    await screen.findByText("Always on — nothing to configure.");
    // The plain outcome bullet renders...
    expect(screen.getByText("Chat with your agent right here in the dashboard")).toBeTruthy();
    // ...but the internal taxonomy is never surfaced to the guardian.
    expect(screen.queryByText("Capabilities")).toBeNull();
    expect(screen.queryByText("Talk")).toBeNull();
  });
});

describe("ConnectionDetailPage — OAuth service (github)", () => {
  it("renders the Connect button when github is not connected", async () => {
    mockApi([...minimalConnections(), oauth("github", "unauthorized")]);
    renderDetail("github");

    expect(await screen.findByText("Connect")).toBeTruthy();
  });

  it("renders the outcome bullets for github incl. the watch bullet", async () => {
    mockApi([...minimalConnections(), oauth("github", "authorized")]);
    renderDetail("github");

    // github has the work bullet and the allowlisted watch bullet.
    expect(
      await screen.findByText(
        "Work with your repositories, issues, pull requests, and project boards as you",
      ),
    ).toBeTruthy();
    expect(screen.getByText("React when something happens in your repositories")).toBeTruthy();
  });

  it("renders Reconnect + Disconnect when the grant is conferred", async () => {
    mockApi([...minimalConnections(), oauth("github", "authorized")]);
    renderDetail("github");

    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});

describe("ConnectionDetailPage — enablement bullets", () => {
  it("webchat: the dashboard-chat bullet", async () => {
    mockApi();
    renderDetail("webchat");

    const text = await screen.findByText("Chat with your agent right here in the dashboard");
    expect(text).toBeTruthy();
  });

  it("google: the outcome bullet phrased for the service", async () => {
    mockApi([...minimalConnections(), oauth("google", "authorized")]);
    renderDetail("google");

    expect(await screen.findByText("Work across your Google services as you")).toBeTruthy();
  });
});

describe("ConnectionDetailPage — several accounts", () => {
  function feishu(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return connection({
      service: "feishu",
      channel: "feishu",
      grants: { app: "authorized" },
      capabilities: {
        talk: { state: "unlocked" },
        act: { state: "unsupported" },
        watch: { state: "unsupported" },
      },
      severalAccounts: true,
      ...overrides,
    });
  }

  const secondFeishu = () =>
    feishu({
      id: "conn-feishu-2",
      channel: SECOND_FEISHU,
      display: {
        app: { displayName: "Sales Bot", handle: null, email: null, avatarUrl: null },
      },
    });

  function renderWithLocation(initial: string) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const locations: string[] = [];
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route
              path="/settings/connections/:serviceId"
              element={
                <>
                  <ConnectionDetailPage />
                  <LocationCapture onLocation={(p) => locations.push(p)} />
                </>
              }
            />
            <Route
              path="/settings/connections"
              element={<LocationCapture onLocation={(p) => locations.push(p)} />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { locations };
  }

  it("opens the second account at its channel id", async () => {
    mockApi([feishu(), secondFeishu()]);
    renderDetail(SECOND_FEISHU);

    expect(await screen.findByText("Feishu · Sales Bot")).toBeTruthy();
  });

  it("keeps the service route on the first account", async () => {
    mockApi([feishu(), secondFeishu()]);
    renderDetail("feishu");

    const title = await screen.findByRole("heading", { level: 1 });
    expect(title.textContent).toBe("Feishu");
  });

  it("adds another account, then navigates to its route", async () => {
    const accounts = [feishu()];
    const posts: unknown[] = [];
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/connections" && init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        const created = feishu({
          id: "conn-feishu-2",
          channel: SECOND_FEISHU,
          grants: { app: "unauthorized" },
        });
        accounts.push(created);
        return new Response(JSON.stringify({ connection: created }), { status: 201 });
      }
      if (url === "/api/connections") {
        return new Response(JSON.stringify({ connections: accounts }), { status: 200 });
      }
      if (url === "/api/integrations/composio/status") {
        return new Response(JSON.stringify({ composio: null }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const { locations } = renderWithLocation("/settings/connections/feishu");

    fireEvent.click(await screen.findByRole("button", { name: "Add another account" }));

    await waitFor(() => {
      expect(locations).toContain(`/settings/connections/${SECOND_FEISHU}`);
    });
    expect(posts).toEqual([{ service: "feishu" }]);
    expect(await screen.findByText("Not connected")).toBeTruthy();
  });

  it("stays on the account when the refetched list lacks the new one", async () => {
    let posted = false;
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/connections" && init?.method === "POST") {
        posted = true;
        const created = feishu({ id: "conn-feishu-2", channel: SECOND_FEISHU });
        return new Response(JSON.stringify({ connection: created }), { status: 201 });
      }
      if (url === "/api/connections") {
        return new Response(JSON.stringify({ connections: [feishu()] }), { status: 200 });
      }
      if (url === "/api/integrations/composio/status") {
        return new Response(JSON.stringify({ composio: null }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const { locations } = renderWithLocation("/settings/connections/feishu");

    const add = await screen.findByRole("button", { name: "Add another account" });
    fireEvent.click(add);

    await waitFor(() => {
      expect(posted).toBe(true);
      expect((add as HTMLButtonElement).disabled).toBe(false);
    });
    expect(locations).not.toContain(`/settings/connections/${SECOND_FEISHU}`);
    expect(locations).not.toContain("/settings/connections");
  });
});
