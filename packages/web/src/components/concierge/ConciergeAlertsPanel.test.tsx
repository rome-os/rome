// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConciergeAlertsResponse } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { ConciergeAlertsPanel } from "./ConciergeAlertsPanel";

const toast = rs.hoisted(() => ({ error: rs.fn(), success: rs.fn() }));
rs.mock("sonner", () => ({ toast }));

let state: ConciergeAlertsResponse;
const requests: { method: string; url: string; body?: unknown }[] = [];

function mockServer() {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method !== "GET") requests.push({ method, url, body });
    if (url === "/api/concierge/alerts") return json(state);
    const kind = url.match(/^\/api\/concierge\/alerts\/repos\/([^/]+)\/([^/]+)\/kinds\/(\w+)$/);
    if (kind && method === "PUT") {
      const repo = state.repos.find((entry) => entry.repo === `${kind[1]}/${kind[2]}`)!;
      repo.kinds = repo.kinds.map((k) =>
        k.kind === kind[3] ? { ...k, enabled: body.enabled } : k,
      );
      return json({ repo });
    }
    if (url.startsWith("/api/concierge/alerts/repos/") && method === "DELETE") {
      return json({ removed: 5 });
    }
    if (url === "/api/concierge/alerts/rules" && method === "PUT") {
      state.rules = { ...state.rules, ...body };
      return json({ rules: state.rules });
    }
    return json({ error: "not found" }, 404);
  }) as typeof fetch);
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConciergeAlertsPanel />
    </QueryClientProvider>,
  );
}

describe("ConciergeAlertsPanel", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  beforeEach(() => {
    requests.length = 0;
    state = {
      repos: [
        {
          repo: "acme/widgets",
          login: "octo-me",
          kinds: [
            { kind: "pull_request", enabled: true },
            { kind: "workflow_run", enabled: false },
          ],
        },
      ],
      rules: { maxTurnsPerHour: 2, minSpacingMinutes: 15, quietHours: null },
    };
    mockServer();
  });
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("shows each watched repo with its kinds, and turns a kind on", async () => {
    renderPanel();
    const ci = await screen.findByRole("switch", { name: "Your failed CI runs" });
    expect(screen.getByText("acme/widgets")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Review requests for you" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(ci.getAttribute("aria-checked")).toBe("false");
    await userEvent.click(ci);
    await waitFor(() => expect(ci.getAttribute("aria-checked")).toBe("true"));
    expect(requests).toEqual([
      {
        method: "PUT",
        url: "/api/concierge/alerts/repos/acme/widgets/kinds/workflow_run",
        body: { enabled: true },
      },
    ]);
  });

  it("stops watching a repo", async () => {
    renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop watching acme/widgets" }),
    );
    await waitFor(() => expect(screen.queryByText("acme/widgets")).toBeNull());
    expect(requests).toEqual([
      { method: "DELETE", url: "/api/concierge/alerts/repos/acme/widgets" },
    ]);
    expect(screen.getByText("No repos watched")).toBeTruthy();
  });

  it("edits the rate limit and turns quiet hours on", async () => {
    renderPanel();
    const perHour = await screen.findByLabelText("Most alerts per hour");
    await userEvent.clear(perHour);
    await userEvent.type(perHour, "4{Enter}");
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PUT",
        url: "/api/concierge/alerts/rules",
        body: { maxTurnsPerHour: 4 },
      }),
    );
    await userEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PUT",
        url: "/api/concierge/alerts/rules",
        body: { quietHours: { start: "22:00", end: "08:00" } },
      }),
    );
    expect(await screen.findByLabelText("Until")).toBeTruthy();
  });

  it("puts back a rate limit out of bounds without saving it", async () => {
    renderPanel();
    const perHour = (await screen.findByLabelText("Most alerts per hour")) as HTMLInputElement;
    await userEvent.clear(perHour);
    await userEvent.type(perHour, "99{Enter}");
    expect(perHour.value).toBe("2");
    expect(requests).toEqual([]);
  });
});
