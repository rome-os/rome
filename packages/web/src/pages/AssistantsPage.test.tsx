// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { Assistant } from "@rome/api-types/assistants";
import type { TimelinePage } from "@rome/api-types/people";
import "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { AssistantsPage } from "./AssistantsPage";

const DOT = "11111111-1111-4111-8111-111111111111";
const MUSE = "22222222-2222-4222-8222-222222222222";

const assistant = (agentId: string, name: string, kind: string): Assistant => ({
  agentId,
  name,
  kind,
  account: "eric",
  sameAccount: true,
  lastMessageAt: null,
});

/** What each assistant's chat holds, newest first as the server answers. */
const chats: Record<string, TimelinePage> = {
  [DOT]: {
    entries: [
      { source: "agents", timestamp: 1, body: "Q3 draft?", direction: "inbound", ref: "d1" },
    ],
    nextCursor: null,
  },
  [MUSE]: {
    entries: [
      { source: "agents", timestamp: 2, body: "Build passed", direction: "inbound", ref: "m1" },
    ],
    nextCursor: null,
  },
};

function serve(assistants: Assistant[] | "fail") {
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/assistants") {
      return assistants === "fail"
        ? new Response("{}", { status: 503 })
        : Response.json({ assistants });
    }
    const chat = url.match(/^\/api\/assistants\/([^/]+)\/messages/)?.[1];
    if (chat) return Response.json(chats[chat] ?? { entries: [], nextCursor: null });
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPage(path = "/assistants") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={queryClient}>
          <AssistantsPage />
          <Location />
        </QueryClientProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

const switcher = () => screen.findByRole("button", { name: /^Switch assistant/ });

describe("AssistantsPage", () => {
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("opens on the chat that moved last", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    renderPage();
    expect((await switcher()).textContent).toContain("Muse");
    expect(await screen.findByText("Build passed")).toBeTruthy();
  });

  it("opens the chat the address names", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    renderPage(`/assistants?id=${DOT}`);
    expect((await switcher()).textContent).toContain("Research dot");
    expect(await screen.findByText("Q3 draft?")).toBeTruthy();
  });

  it("switches to another assistant from the header", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    const user = userEvent.setup();
    renderPage();

    await user.click(await switcher());
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent?.startsWith("Muse"))).toEqual([true, false]);
    expect(items[1]!.textContent?.startsWith("Research dot")).toBe(true);
    // Each item names its kind for screen readers, beside the mark.
    expect(within(items[1]!).getByText("Dot")).toBeTruthy();

    await user.click(items[1]!);
    expect((await switcher()).textContent).toContain("Research dot");
    expect(await screen.findByText("Q3 draft?")).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe(`?id=${DOT}`);
  });

  it("names a kind it has no mark for, as Rome Cloud spells it", async () => {
    serve([assistant(DOT, "Grok", "grok")]);
    const user = userEvent.setup();
    renderPage();
    await user.click(await switcher());
    const [item] = await screen.findAllByRole("menuitem");
    expect(within(item!).getByText("grok")).toBeTruthy();
  });

  it("says how to connect one when there are none", async () => {
    serve([]);
    renderPage();
    expect(await screen.findByText("No assistants yet")).toBeTruthy();
  });

  it("says so when the list cannot be read, rather than showing none", async () => {
    serve("fail");
    renderPage();
    expect(await screen.findByText("Failed to load assistants")).toBeTruthy();
    expect(screen.queryByText("No assistants yet")).toBeNull();
  });
});
