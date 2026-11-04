// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConciergeFollowingResponse } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { ConciergeFollowingPanel } from "./ConciergeFollowingPanel";

const toast = rs.hoisted(() => ({ error: rs.fn(), success: rs.fn() }));
rs.mock("sonner", () => ({ toast }));

let state: ConciergeFollowingResponse;
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
    if (url === "/api/concierge/following") return json(state);
    const parsed = new URL(url, "http://rome.test");
    const target = parsed.searchParams.get("target");
    const kind = parsed.pathname.match(/^\/api\/concierge\/following\/(\w+)\/kinds\/(\w+)$/);
    if (kind && method === "PUT") {
      const item = state.items.find(
        (entry) => entry.source === kind[1] && entry.target === target,
      )!;
      item.kinds = item.kinds.map((k) =>
        k.kind === kind[2] ? { ...k, enabled: body.enabled } : k,
      );
      return json({ item });
    }
    if (/^\/api\/concierge\/following\/\w+$/.test(parsed.pathname) && method === "DELETE") {
      return json({ removed: 1 });
    }
    if (url === "/api/concierge/following/rules" && method === "PUT") {
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
      <ConciergeFollowingPanel />
    </QueryClientProvider>,
  );
}

describe("ConciergeFollowingPanel", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  beforeEach(() => {
    requests.length = 0;
    state = {
      items: [
        {
          source: "github",
          target: "acme/widgets",
          account: "octo-me",
          kinds: [
            { kind: "pull_request", enabled: true },
            { kind: "workflow_run", enabled: false },
          ],
        },
        {
          source: "gmail",
          target: "me@example.com",
          account: "me@example.com",
          kinds: [{ kind: "new_mail", enabled: true }],
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
        url: "/api/concierge/following/github/kinds/workflow_run?target=acme%2Fwidgets",
        body: { enabled: true },
      },
    ]);
  });

  it("groups what is followed by source, GitHub first", async () => {
    const { container } = renderPanel();
    await screen.findByText("me@example.com");
    const groups = [...container.querySelectorAll("[data-following-source]")];
    expect(groups.map((group) => group.getAttribute("data-following-source"))).toEqual([
      "github",
      "gmail",
    ]);
    expect(groups.map((group) => group.querySelector("h3")?.textContent)).toEqual([
      "GitHub",
      "Gmail",
    ]);
    // A repo names the login it is judged for; a mailbox is its own account.
    expect(screen.getByText("For @octo-me")).toBeTruthy();
    expect(screen.queryByText("For @me@example.com")).toBeNull();
    expect(screen.getByRole("switch", { name: "New mail from people" })).toBeTruthy();
  });

  it("stops following an item, and shows the empty state once nothing is left", async () => {
    renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop following me@example.com" }),
    );
    await waitFor(() => expect(screen.queryByText("me@example.com")).toBeNull());
    expect(requests).toEqual([
      { method: "DELETE", url: "/api/concierge/following/gmail?target=me%40example.com" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Stop following acme/widgets" }));
    expect(await screen.findByText("Nothing followed yet")).toBeTruthy();
  });

  it("edits the rate limit and turns quiet hours on", async () => {
    renderPanel();
    const perHour = await screen.findByLabelText("Most messages per hour");
    await userEvent.clear(perHour);
    await userEvent.type(perHour, "4{Enter}");
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PUT",
        url: "/api/concierge/following/rules",
        body: { maxTurnsPerHour: 4 },
      }),
    );
    await userEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PUT",
        url: "/api/concierge/following/rules",
        body: { quietHours: { start: "22:00", end: "08:00" } },
      }),
    );
    expect(await screen.findByLabelText("Until")).toBeTruthy();
  });

  it("puts back a rate limit out of bounds without saving it", async () => {
    renderPanel();
    const perHour = (await screen.findByLabelText("Most messages per hour")) as HTMLInputElement;
    await userEvent.clear(perHour);
    await userEvent.type(perHour, "99{Enter}");
    expect(perHour.value).toBe("2");
    expect(requests).toEqual([]);
  });
});
