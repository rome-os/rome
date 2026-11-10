// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ConciergeTaskDto } from "@rome/api-types/concierge";
import i18n from "@/i18n";
import { ToolTasksContext, type ToolTasksHost } from "@/pages/free/tool-tasks";
import { useConciergeTaskList } from "./ConciergeTaskList";
import { resetPending } from "./task-pending";

const doing: ConciergeTaskDto = {
  id: "task-1",
  title: "Fix flaky test",
  state: "doing",
  summary: null,
  waitingOn: null,
  dueAt: null,
  rank: null,
  chat: null,
  sourceMessageId: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: null,
  archivedAt: null,
  notSynced: false,
  conciergeChat: { id: "concierge", name: "Concierge", main: true },
};

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
beforeEach(() => {
  resetPending();
  rs.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
    String(input).startsWith("/api/concierge/tasks")
      ? new Response(JSON.stringify({ tasks: [doing] }), {
          headers: { "content-type": "application/json" },
        })
      : new Response("not found", { status: 404 })) as typeof fetch);
});
afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

function host(overrides: Partial<ToolTasksHost> = {}): ToolTasksHost {
  return { active: false, compact: false, show: rs.fn(), hide: rs.fn(), ...overrides };
}

function Opener() {
  const { open, sheet } = useConciergeTaskList("concierge");
  return (
    <>
      <button type="button" onClick={open}>
        Open
      </button>
      {sheet}
    </>
  );
}

function renderOpener(pane: ToolTasksHost | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Opener />
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    pane ? <ToolTasksContext.Provider value={pane}>{tree}</ToolTasksContext.Provider> : tree,
  );
}

describe("useConciergeTaskList", () => {
  it("shows the pane's Tasks tab, also when it shows already", async () => {
    const user = userEvent.setup();
    const pane = host({ active: true });
    renderOpener(pane);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(pane.show).toHaveBeenCalledTimes(1);
    expect(pane.hide).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a full-height sheet instead where the pane would take the whole width", async () => {
    const user = userEvent.setup();
    const pane = host({ compact: true });
    renderOpener(pane);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const sheet = await screen.findByRole("dialog", { name: "Tasks" });
    expect(pane.show).not.toHaveBeenCalled();
    expect(sheet.className).toContain("w-full");
    expect(await within(sheet).findByText("Fix flaky test")).toBeTruthy();
    await user.click(within(sheet).getByRole("button", { name: "Close tasks" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the sheet outside a tool workspace", async () => {
    const user = userEvent.setup();
    renderOpener(null);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "Tasks" })).toBeTruthy();
  });

  it("removes the pane's tab when the chat goes", () => {
    const pane = host();
    renderOpener(pane).unmount();
    expect(pane.hide).toHaveBeenCalled();
  });
});
