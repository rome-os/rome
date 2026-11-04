// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { ConciergeFollowingPanel } from "./ConciergeFollowingPanel";

let state: ConciergeConnectorsResponse;

const UNSUPPORTED = { state: "unsupported" } as const;

function listing(): ConciergeConnectorsResponse {
  return {
    connectors: [
      {
        service: "github",
        label: "GitHub",
        origin: "connection",
        connectionId: "c1",
        state: "working",
        account: "octo-me",
        connect: null,
        capabilities: {
          chat: UNSUPPORTED,
          act: UNSUPPORTED,
          watch: {
            state: "unlocked",
            account: "octo-me",
            target: { format: "A repository as owner/name", example: "rome-os/rome" },
            kinds: [
              {
                kind: "review_requested",
                label: "Review requested of you or your team",
                default: true,
              },
              { kind: "your_ci_failed", label: "Your CI runs that failed", default: true },
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
                ],
                options: { scope: "about_me", ignorePeople: ["dependabot"], includeBots: false },
                preference: "Only billing changes",
              },
            ],
          },
        },
      },
      {
        service: "gmail",
        label: "Gmail",
        origin: "composio",
        connectionId: null,
        state: "working",
        account: "me@example.com",
        connect: null,
        capabilities: {
          chat: UNSUPPORTED,
          act: { state: "unlocked" },
          watch: {
            state: "unlocked",
            account: "me@example.com",
            target: null,
            kinds: [{ kind: "new_mail", label: "New mail from people", default: true }],
            options: [],
            follows: [],
          },
        },
      },
      {
        service: "notion",
        label: "Notion",
        origin: "composio",
        connectionId: null,
        state: "working",
        account: null,
        connect: null,
        capabilities: { chat: UNSUPPORTED, act: { state: "unlocked" }, watch: UNSUPPORTED },
      },
    ],
    rules: { digestTimes: ["09:00", "18:00"], quietHours: null },
  };
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
    state = listing();
    rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
      String(input) === "/api/concierge/connectors"
        ? new Response(JSON.stringify(state), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response("{}", { status: 404 })) as typeof fetch);
  });
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("shows only what is followed, by source: target, kinds on, options set and the preference", async () => {
    const { container } = renderPanel();
    const item = (await screen.findByText("acme/widgets")).closest("li")!;
    expect(screen.getByText("GitHub · octo-me")).toBeTruthy();
    expect(within(item).getByText("Review requested of you or your team")).toBeTruthy();
    expect(within(item).queryByText(/Your CI runs that failed/)).toBeNull();
    // Only options that differ from their default.
    expect(within(item).getByText("Ignore these people: dependabot")).toBeTruthy();
    expect(within(item).queryByText(/What to hear about/)).toBeNull();
    expect(within(item).getByText("“Only billing changes”")).toBeTruthy();
    // A source with nothing followed, and a tool that cannot be watched, are not listed.
    expect(
      [...container.querySelectorAll("[data-following-source]")].map((s) =>
        s.getAttribute("data-following-source"),
      ),
    ).toEqual(["github"]);
  });

  it("offers no controls: changes go through the Concierge in chat", async () => {
    renderPanel();
    await screen.findByText("acme/widgets");
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.getByText(/ask the Concierge in chat/)).toBeTruthy();
  });

  it("shows the empty state when nothing is followed", async () => {
    state.connectors[0]!.capabilities.watch.follows = [];
    renderPanel();
    expect(await screen.findByText("Nothing followed yet")).toBeTruthy();
  });
});
