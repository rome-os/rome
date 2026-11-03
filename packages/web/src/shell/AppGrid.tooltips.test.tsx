// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18n from "@/i18n";
import { AppGrid } from "./AppGrid";
import { RailLabelsContext } from "./sidebar-shared";

const fetchMock = rs.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (url === "/api/apps") return json({ apps: [] });
  if (url === "/api/apps/updates") return json({ upgradable: [] });
  if (url === "/api/settings") return json({});
  return new Response(null, { status: 404 });
});

function Sidebar({ labelled }: { labelled: boolean }) {
  return (
    <RailLabelsContext.Provider value={labelled}>
      <AppGrid />
    </RailLabelsContext.Provider>
  );
}

function renderSidebar(labelled: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (value: boolean) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/chat"]}>
        <Sidebar labelled={value} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(wrap(labelled));
  return { ...result, setLabelled: (value: boolean) => result.rerender(wrap(value)) };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockClear();
  rs.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
  localStorage.clear();
});

describe("rail tooltips", () => {
  it("shows no tooltips after the open sidebar collapses, even if tiles were hovered", async () => {
    const { setLabelled } = renderSidebar(true);
    for (const name of ["Chat", "Projects"]) {
      const tile = screen.getByRole("link", { name });
      fireEvent.pointerMove(tile);
      // Longer than the rail's 150ms delay, so a tooltip would open.
      await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
      fireEvent.pointerLeave(tile);
    }

    setLabelled(false);

    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryAllByRole("tooltip")).toHaveLength(0);
  });

  it("still shows a tile's name when the collapsed rail is hovered", async () => {
    renderSidebar(false);
    fireEvent.pointerMove(screen.getByRole("link", { name: "Projects" }));
    await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe("Projects"));
  });
});
