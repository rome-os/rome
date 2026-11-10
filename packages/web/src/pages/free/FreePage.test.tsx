// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import FreePage, { MainChatRedirect } from "./FreePage";

const concierge = rs.hoisted(() => ({
  state: { chatId: null as string | null, loading: false, failed: false },
  retry: rs.fn(),
}));
rs.mock("@/hooks/use-concierge", () => ({
  useConciergeChat: () => ({ ...concierge.state, retry: concierge.retry }),
}));
// The grid reads its chat from the `sessionId` prop or, without one, from the route.
rs.mock("./FreeGrid", () => ({
  FreeGrid: ({ sessionId }: { sessionId?: string }) => (
    <output data-testid="grid">{sessionId ?? "from the route"}</output>
  ),
}));

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{`${pathname}${search}`}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat/concierge" element={<MainChatRedirect />} />
        <Route path="/chat/*" element={<FreePage />} />
        <Route path="/message" element={<FreePage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const on = (chatId: string | null, loading = false, failed = false) => {
  concierge.state = { chatId, loading, failed };
};

afterEach(() => {
  cleanup();
  on(null);
});

describe("FreePage", () => {
  it("opens the guardian's main chat at /message", () => {
    on("concierge");
    renderAt("/message");
    expect(screen.getByTestId("grid").textContent).toBe("concierge");
    expect(screen.getByTestId("where").textContent).toBe("/message");
  });

  it("opens a visitor's own main chat at /message", () => {
    on("visitor-main");
    renderAt("/message");
    expect(screen.getByTestId("grid").textContent).toBe("visitor-main");
  });

  it("waits for the main chat's id rather than guessing it", () => {
    on(null, true);
    renderAt("/message");
    expect(screen.queryByTestId("grid")).toBeNull();
    expect(screen.getByTestId("where").textContent).toBe("/message");
  });

  it("says the main chat could not load, with a retry, rather than opening a blank chat", () => {
    on(null, false, true);
    renderAt("/message");
    expect(screen.queryByTestId("grid")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("recentChats.mainChatUnavailable");
    fireEvent.click(screen.getByRole("button", { name: "recentChats.searchRetry" }));
    expect(concierge.retry).toHaveBeenCalled();
  });

  it("leaves a chat route to name its own chat", () => {
    on("concierge");
    renderAt("/chat/topic-1");
    expect(screen.getByTestId("grid").textContent).toBe("from the route");
    expect(screen.getByTestId("where").textContent).toBe("/chat/topic-1");
  });
});

describe("MainChatRedirect", () => {
  it("sends the old /chat/concierge address to /message, keeping the query", () => {
    on("concierge");
    renderAt("/chat/concierge?hideSidebar=1");
    expect(screen.getByTestId("where").textContent).toBe("/message?hideSidebar=1");
    expect(screen.getByTestId("grid").textContent).toBe("concierge");
  });
});
