// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { Assistant } from "@rome/api-types/assistants";
import type { Message } from "@rome/api-types/message";
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

const inbound = (ref: string, body: string, timestamp: number, sender?: string): Message => ({
  source: "agents",
  timestamp,
  body,
  direction: "inbound",
  ref,
  ...(sender ? { sender: { id: null, name: sender } } : {}),
});

/** What the server holds. Each chat's newest page, newest first, and the page
 *  a cursor names. A test may change any of it mid-run. */
let latest: Record<string, TimelinePage> = {};
let olderPages: Record<string, TimelinePage> = {};
/** What GET /api/assistants answers. */
let listed: Assistant[] | "fail" = [];
/** How many reads of older history fail before one succeeds. */
let olderFailures = 0;
/** Each send the page posted. */
const sends: { text: string }[] = [];

interface ServeOptions {
  /** How many sends the channel refuses before it takes one. */
  refuse?: number;
  /** How many sends never reach the server. */
  loseRequests?: number;
}

function serve(assistants: Assistant[] | "fail", options: ServeOptions = {}) {
  const { refuse = 0, loseRequests = 0 } = options;
  listed = assistants;
  latest = {
    [DOT]: { entries: [inbound("d1", "Q3 draft?", 1)], nextCursor: null },
    [MUSE]: { entries: [inbound("m1", "Build passed", 2)], nextCursor: null },
  };
  olderPages = {};
  olderFailures = 0;
  sends.length = 0;
  let lost = 0;
  let refused = 0;
  rs.spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (init?.method === "POST" && url.endsWith("/messages")) {
      if (lost < loseRequests) {
        lost++;
        throw new TypeError("Failed to fetch");
      }
      sends.push(JSON.parse(String(init.body)) as { text: string });
      if (refused < refuse) {
        refused++;
        return Response.json({ error: "not reachable" }, { status: 502 });
      }
      return Response.json({ ref: "agents:3", timestamp: 3 });
    }
    if (url === "/api/assistants") {
      return listed === "fail"
        ? new Response("{}", { status: 503 })
        : Response.json({ assistants: listed });
    }
    const chat = url.match(/^\/api\/assistants\/([^/?]+)\/messages(\?cursor=.+)?$/);
    if (chat) {
      if (chat[2] && olderFailures > 0) {
        olderFailures--;
        return new Response("{}", { status: 503 });
      }
      const page = chat[2] ? olderPages[chat[1]!] : latest[chat[1]!];
      return Response.json(page ?? { entries: [], nextCursor: null });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
}

function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPage(path = "/assistants") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={queryClient}>
          <AssistantsPage />
          <Location />
        </QueryClientProvider>
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { ...view, queryClient };
}

const switcher = () => screen.findByRole("button", { name: /^Switch assistant/ });
const location = () => screen.getByTestId("location").textContent;

describe("AssistantsPage", () => {
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("opens on the chat that moved last, and writes it into the address", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    renderPage();
    expect((await switcher()).textContent).toContain("Muse");
    expect(await screen.findByText("Build passed")).toBeTruthy();
    await waitFor(() => expect(location()).toBe(`?id=${MUSE}`));
  });

  it("keeps the chat it opened on when the list refreshes into a new order", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    const { queryClient } = renderPage();
    await waitFor(() => expect(location()).toBe(`?id=${MUSE}`));

    // The Dot's chat moves, so the list now leads with it.
    listed = [assistant(DOT, "Research dot", "dot"), assistant(MUSE, "Muse", "muse")];
    await queryClient.invalidateQueries({ queryKey: ["assistants"] });
    expect((await switcher()).textContent).toContain("Muse");
    expect(location()).toBe(`?id=${MUSE}`);
  });

  it("opens the chat the address names", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    renderPage(`/assistants?id=${DOT}`);
    expect((await switcher()).textContent).toContain("Research dot");
    expect(await screen.findByText("Q3 draft?")).toBeTruthy();
  });

  it("opens no other chat for an address naming an assistant not listed", async () => {
    const gone = "33333333-3333-4333-8333-333333333333";
    serve([assistant(MUSE, "Muse", "muse")]);
    const user = userEvent.setup();
    renderPage(`/assistants?id=${gone}`);

    expect(await screen.findByText("This assistant isn't available")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Message Muse")).toBeNull();
    expect(location()).toBe(`?id=${gone}`);

    await user.click(screen.getByRole("button", { name: "Open the latest chat" }));
    expect((await switcher()).textContent).toContain("Muse");
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
    expect(location()).toBe(`?id=${DOT}`);
  });

  it("names the assistant as listed now, not by the label frozen into its message", async () => {
    serve([assistant(DOT, "Research dot", "dot")]);
    latest[DOT] = { entries: [inbound("d1", "Q3 draft?", 1, "Old name (dot)")], nextCursor: null };
    renderPage();
    expect(await screen.findByText("Q3 draft?")).toBeTruthy();
    expect(screen.queryByText("Old name (dot)")).toBeNull();
  });

  it("keeps reading new messages after older history is loaded", async () => {
    serve([assistant(DOT, "Research dot", "dot")]);
    latest[DOT] = { entries: [inbound("d2", "Newest", 2)], nextCursor: "c1" };
    olderPages[DOT] = { entries: [inbound("d1", "Oldest", 1)], nextCursor: null };
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Load older messages" }));
    expect(await screen.findByText("Oldest")).toBeTruthy();

    latest[DOT] = {
      entries: [inbound("d3", "Just arrived", 3), inbound("d2", "Newest", 2)],
      nextCursor: "c1",
    };
    expect(await screen.findByText("Just arrived", {}, { timeout: 8_000 })).toBeTruthy();
    expect(screen.getByText("Oldest")).toBeTruthy();
  }, 15_000);

  it("keeps the messages a new arrival pushes out of the newest page", async () => {
    serve([assistant(DOT, "Research dot", "dot")]);
    // A newest page two messages long, with one more before it.
    latest[DOT] = {
      entries: [inbound("d3", "Third", 3), inbound("d2", "Second", 2)],
      nextCursor: "c2",
    };
    olderPages[DOT] = { entries: [inbound("d1", "First", 1)], nextCursor: null };
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Load older messages" }));
    expect(await screen.findByText("First")).toBeTruthy();

    // A new message pushes "Second" out of the newest page.
    latest[DOT] = {
      entries: [inbound("d4", "Fourth", 4), inbound("d3", "Third", 3)],
      nextCursor: "c3",
    };
    expect(await screen.findByText("Fourth", {}, { timeout: 8_000 })).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
    expect(screen.getByText("First")).toBeTruthy();
  }, 15_000);

  it("gives a refused send's draft back with the channel's words, and sends it again", async () => {
    serve([assistant(DOT, "Research dot", "dot")], { refuse: 1 });
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByPlaceholderText("Message Research dot");
    await user.type(box, "Are you there?{Enter}");
    expect(await screen.findByText("not reachable")).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("Are you there?");

    await user.type(box, "{Enter}");
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toEqual({ text: "Are you there?" });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  it("gives the draft back when the send never reached the server", async () => {
    serve([assistant(DOT, "Research dot", "dot")], { loseRequests: 1 });
    const user = userEvent.setup();
    renderPage();

    const box = await screen.findByPlaceholderText("Message Research dot");
    await user.type(box, "Ship it{Enter}");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("Ship it"));
    expect(sends).toHaveLength(0);
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

  it("says so when the list cannot be read after it was read empty", async () => {
    serve([]);
    const { queryClient } = renderPage();
    expect(await screen.findByText("No assistants yet")).toBeTruthy();

    listed = "fail";
    await queryClient.invalidateQueries({ queryKey: ["assistants"] });
    expect(await screen.findByText("Failed to load assistants")).toBeTruthy();
    expect(screen.queryByText("No assistants yet")).toBeNull();
  });

  it("offers older history again after its first read fails", async () => {
    serve([assistant(DOT, "Research dot", "dot")]);
    latest[DOT] = { entries: [inbound("d2", "Newest", 2)], nextCursor: "c1" };
    olderPages[DOT] = { entries: [inbound("d1", "Oldest", 1)], nextCursor: null };
    olderFailures = 1;
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Load older messages" }));
    expect(await screen.findByText("Failed to load older messages")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Load older messages" }));
    expect(await screen.findByText("Oldest")).toBeTruthy();
  });

  it("says so when the list cannot be read, rather than showing none", async () => {
    serve("fail");
    renderPage();
    expect(await screen.findByText("Failed to load assistants")).toBeTruthy();
    expect(screen.queryByText("No assistants yet")).toBeNull();
  });
});
