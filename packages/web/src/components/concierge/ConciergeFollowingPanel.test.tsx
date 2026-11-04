// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConciergeFollowingResponse } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { ConciergeFollowingPanel } from "./ConciergeFollowingPanel";

const toast = rs.hoisted(() => ({ error: rs.fn(), success: rs.fn() }));
rs.mock("sonner", () => ({ toast }));

let state: ConciergeFollowingResponse;
const requests: { method: string; url: string; body?: unknown }[] = [];

function initialState(): ConciergeFollowingResponse {
  return {
    sources: [
      {
        source: "github",
        label: "GitHub",
        status: "ready",
        account: "octo-me",
        target: { format: "A repository as owner/name", example: "rome-os/rome" },
        kinds: [
          {
            kind: "review_requested",
            label: "Review requested of you or your team",
            default: true,
          },
          { kind: "your_ci_failed", label: "Your CI runs that failed", default: true },
          {
            kind: "new_pr_or_issue",
            label: "New pull requests and issues in the repository",
            default: false,
            requires: { option: "scope", value: "whole_repo" },
          },
        ],
        options: [
          {
            key: "scope",
            label: "What to hear about",
            type: "enum",
            values: [
              { value: "about_me", label: "Only what concerns me" },
              { value: "whole_repo", label: "Also the whole repository" },
            ],
            default: "about_me",
          },
          { key: "ignorePeople", label: "Ignore these people", type: "list", default: [] },
          { key: "includeBots", label: "Include bots", type: "boolean", default: false },
        ],
        follows: [
          {
            target: "acme/widgets",
            state: "active",
            kinds: [
              { kind: "review_requested", on: true },
              { kind: "your_ci_failed", on: false },
              { kind: "new_pr_or_issue", on: false },
            ],
            options: { scope: "about_me", ignorePeople: ["dependabot"], includeBots: false },
            preference: null,
          },
        ],
      },
      {
        source: "gmail",
        label: "Gmail",
        status: "ready",
        account: "me@example.com",
        target: null,
        kinds: [{ kind: "new_mail", label: "New mail from people", default: true }],
        options: [],
        follows: [],
      },
      {
        source: "notion",
        label: "Notion",
        status: "not_supported",
        statusReason: "Notion is connected, but Rome cannot follow it yet.",
        target: null,
        kinds: [],
        options: [],
        follows: [],
      },
    ],
    rules: { maxTurnsPerHour: 2, minSpacingMinutes: 15, quietHours: null },
  };
}

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
    if (url === "/api/concierge/following/item" && method === "PUT") {
      const source = state.sources.find((s) => s.source === body.source)!;
      const follow = source.follows.find((f) => f.target === body.target)!;
      if (body.kinds) {
        follow.kinds = follow.kinds.map((k) =>
          k.kind in body.kinds ? { ...k, on: body.kinds[k.kind] } : k,
        );
      }
      if (body.options) follow.options = { ...follow.options, ...body.options };
      if (body.preference !== undefined) follow.preference = body.preference;
      return json({ follow });
    }
    if (url.startsWith("/api/concierge/following/item?") && method === "DELETE") {
      return json({ removed: true });
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
    state = initialState();
    mockServer();
  });
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("shows each follow with readable kinds, its options and the account it is judged for", async () => {
    renderPanel();
    const item = await screen.findByText("acme/widgets");
    expect(screen.getByText("GitHub · octo-me")).toBeTruthy();
    const section = item.closest("section")!;
    expect(
      within(section).getByRole("switch", { name: "Review requested of you or your team" }),
    ).toBeTruthy();
    // A kind that needs the whole repository shows only with that scope.
    expect(
      within(section).queryByText("New pull requests and issues in the repository"),
    ).toBeNull();
    expect((within(section).getByLabelText("Ignore these people") as HTMLInputElement).value).toBe(
      "dependabot",
    );
  });

  it("turns a kind on, changes an option and saves the preference by the names the list gives", async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole("switch", { name: "Your CI runs that failed" }));
    await userEvent.click(screen.getByRole("radio", { name: "Also the whole repository" }));
    expect(await screen.findByText("New pull requests and issues in the repository")).toBeTruthy();
    const preference = screen.getByLabelText(/What matters to you/);
    await userEvent.type(preference, "Only billing changes");
    await userEvent.tab();
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests.map((r) => r.body)).toEqual([
      { source: "github", target: "acme/widgets", kinds: { your_ci_failed: true } },
      { source: "github", target: "acme/widgets", options: { scope: "whole_repo" } },
      { source: "github", target: "acme/widgets", preference: "Only billing changes" },
    ]);
  });

  it("lists what else can be followed, with what is missing", async () => {
    const { container } = renderPanel();
    await screen.findByText("You can also follow");
    const offered = container.querySelector("[data-following-offered]")!;
    expect(within(offered as HTMLElement).getByText("Gmail")).toBeTruthy();
    expect(within(offered as HTMLElement).getByText(/Ready\. Ask the Concierge/)).toBeTruthy();
    expect(
      within(offered as HTMLElement).getByText(
        "Notion is connected, but Rome cannot follow it yet.",
      ),
    ).toBeTruthy();
  });

  it("stops following an item, and shows the empty state once nothing is left", async () => {
    renderPanel();
    await userEvent.click(
      await screen.findByRole("button", { name: "Stop following acme/widgets" }),
    );
    await waitFor(() => expect(screen.queryByText("acme/widgets")).toBeNull());
    expect(requests).toEqual([
      {
        method: "DELETE",
        url: "/api/concierge/following/item?source=github&target=acme%2Fwidgets",
      },
    ]);
    expect(screen.getByText("Nothing followed yet")).toBeTruthy();
  });

  it("edits the rate limit and puts back a value out of bounds", async () => {
    renderPanel();
    const perHour = (await screen.findByLabelText("Most messages per hour")) as HTMLInputElement;
    await userEvent.clear(perHour);
    await userEvent.type(perHour, "99{Enter}");
    expect(perHour.value).toBe("2");
    await userEvent.clear(perHour);
    await userEvent.type(perHour, "4{Enter}");
    await waitFor(() =>
      expect(requests).toContainEqual({
        method: "PUT",
        url: "/api/concierge/following/rules",
        body: { maxTurnsPerHour: 4 },
      }),
    );
  });
});
