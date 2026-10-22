// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Assistant } from "@rome/api-types/assistants";
import "@/i18n";
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

function serve(assistants: Assistant[] | "fail") {
  rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
    assistants === "fail"
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ assistants }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch);
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <AssistantsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AssistantsPage", () => {
  afterEach(() => {
    cleanup();
    rs.restoreAllMocks();
  });

  it("lists each assistant with its kind's mark, linking to its chat", async () => {
    serve([assistant(MUSE, "Muse", "muse"), assistant(DOT, "Research dot", "dot")]);
    renderPage();

    const rows = await screen.findAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual([
      `/assistants/${MUSE}`,
      `/assistants/${DOT}`,
    ]);
    expect(within(rows[1]!).getByRole("img", { name: "Dot" })).toBeTruthy();
    expect(within(rows[1]!).getByText("Research dot")).toBeTruthy();
    expect(within(rows[0]!).getByText("No messages yet")).toBeTruthy();
  });

  it("names a kind it has no mark for, as Rome Cloud spells it", async () => {
    serve([assistant(DOT, "Grok", "grok")]);
    renderPage();
    expect(await screen.findByRole("img", { name: "grok" })).toBeTruthy();
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
