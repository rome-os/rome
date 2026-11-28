// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import i18n from "@/i18n";
import { SlotOutlet, SlotProvider } from "@/components/slot";
import { TITLEBAR_END_SLOT } from "@/shell/DesktopTitlebar";
import { ToolWorkspace } from "./ToolWorkspace";
import { MIN_TAB_WIDTH, TAB_GAP } from "./tool-tab-fit";
import { useToolOutputs } from "./tool-outputs";
import { useTaskChatInPane, useToolTasks } from "./tool-tasks";
import { useToolTrace } from "./tool-trace";
import * as store from "./use-free-cells";
import type { ToolView, WidgetPlacement } from "./use-free-cells";

rs.mock("@/hooks/use-apps", () => ({ useAppsList: () => ({ apps: [] }) }));
// The task chats' own names, as the server answers them; none read by default.
const sessionNames = new Map<string, string>();
rs.mock("./use-session-names", () => ({
  useSessionNames: (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (sessionNames.has(id) ? [[id, sessionNames.get(id)!]] : []))),
}));
// The panel is tested on its own; here it only has to be the tab's body.
const listMounts = rs.fn();
rs.mock("@/components/concierge/TaskList", () => ({
  TaskList: ({
    chatId,
    onOpenTask,
  }: {
    chatId: string;
    onOpenTask?: (id: string, name: string) => void;
  }) => {
    useEffect(() => listMounts(), []);
    return (
      <>
        <p>Task panel body {chatId}</p>
        {onOpenTask ? (
          <button type="button" onClick={() => onOpenTask("task-7", "Review PRs")}>
            Open task row
          </button>
        ) : null}
      </>
    );
  },
}));

// A task chat's status, as its task link reads it: it needs its owner.
rs.mock("@/components/chat/task-link/task-links", () => ({
  TaskLinksProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useTaskLink: (id: string) => ({
    state: "found",
    task: { id, name: id, status: "needs_you", endReason: null },
  }),
}));

rs.mock("@/components/chat/outputs/OutputsPanel", () => ({
  OutputsPanel: ({
    chatId,
    selectedId,
    onOpenTaskChat,
  }: {
    chatId: string;
    selectedId?: string | null;
    onOpenTaskChat?: (id: string, name: string) => void;
  }) => (
    <>
      <p>
        Outputs body {chatId} {selectedId ?? "none"}
      </p>
      {onOpenTaskChat ? (
        <button type="button" onClick={() => onOpenTaskChat("task-8", "Q3 report")}>
          Open source task
        </button>
      ) : null}
    </>
  ),
}));

let viewportWidth = 1200;
// What the workspace's size observer reports to, so a test can resize it.
let workspaceObservers: Array<() => void> = [];
function resizeWorkspace(width: number) {
  viewportWidth = width;
  act(() => {
    for (const notify of workspaceObservers) notify();
  });
}
let stripWidth: number | null = null;
const mounted = rs.fn();
function ToolContent({ id }: { id: string }) {
  useEffect(() => {
    mounted(id);
  }, [id]);
  return <input aria-label={`Draft ${id}`} defaultValue="" />;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  mounted.mockClear();
  workspaceObservers = [];
  sessionNames.clear();
  localStorage.clear();
  viewportWidth = 1200;
  stripWidth = null;
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const width =
          target.getAttribute("data-testid") === "tool-workspace"
            ? viewportWidth
            : target.getAttribute("role") === "tablist"
              ? stripWidth
              : null;
        if (width !== null) {
          this.callback(
            [{ target, contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        if (target.getAttribute("data-testid") === "tool-workspace") {
          workspaceObservers.push(() =>
            this.callback(
              [{ target, contentRect: { width: viewportWidth } } as ResizeObserverEntry],
              this as unknown as ResizeObserver,
            ),
          );
        }
      }
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const placements: WidgetPlacement[] = [
  { id: "a", type: "desktop", order: 0 },
  { id: "b", type: "projects", order: 1 },
];

function workspace(
  view: ToolView,
  items = placements,
  addWidget = rs.fn(),
  onOpenIntent = rs.fn(),
  label = (widget: WidgetPlacement) => widget.type,
) {
  return (
    <ToolWorkspace
      placements={items}
      view={view}
      selectTool={rs.fn()}
      setCollapsed={rs.fn()}
      addWidget={addWidget}
      removeWidget={rs.fn()}
      label={label}
      icon={() => null}
      content={(widget) => <ToolContent id={widget.id} />}
      fullHref={(widget) => (widget.type === "desktop" ? "/desktop" : null)}
      onOpenIntent={onOpenIntent}
    >
      <input aria-label="Chat draft" />
    </ToolWorkspace>
  );
}

describe("ToolWorkspace", () => {
  it("guides an empty workspace into opening its first app", async () => {
    const user = userEvent.setup();
    const addWidget = rs.fn();
    render(workspace({ activeId: null, collapsed: false, unreadIds: [] }, [], addWidget));
    expect(screen.getByRole("heading", { name: "No apps open" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open an app" }));
    await user.click(screen.getByRole("option", { name: "Projects" }));
    expect(addWidget).toHaveBeenCalledWith("projects", undefined);
  });

  it("keeps draft state and mounted contents across switching, reordering and collapse", async () => {
    const user = userEvent.setup();
    const view = { activeId: "a", collapsed: false, unreadIds: [] };
    const { rerender } = render(workspace(view));
    const first = screen.getByRole("textbox", { name: "Draft a" });
    await user.type(first, "unfinished work");
    expect(screen.queryByRole("textbox", { name: "Draft b" })).toBeNull();
    rerender(workspace({ ...view, activeId: "b" }));
    expect(screen.queryByRole("textbox", { name: "Draft a" })).toBeNull();
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    rerender(
      workspace({ ...view, activeId: "b" }, [
        { ...placements[1], order: 0 },
        { ...placements[0], order: 1 },
      ]),
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "projects",
      "desktop",
    ]);
    rerender(workspace({ ...view, collapsed: true }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    rerender(workspace(view));
    expect(screen.getByRole("textbox", { name: "Draft a" })).toBe(first);
    expect((first as HTMLInputElement).value).toBe("unfinished work");
    expect(mounted).toHaveBeenCalledTimes(2);
  });

  describe("when the tabs do not fit the strip", () => {
    const many: WidgetPlacement[] = ["a", "b", "c", "d", "e"].map((id, order) => ({
      id,
      type: "desktop",
      order,
    }));
    const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.getAttribute("title"));
    const labelled = (view: ToolView) =>
      workspace(view, many, rs.fn(), rs.fn(), (widget) => `app ${widget.id}`);

    it("draws the tabs that fit, and counts the rest on the all-apps menu", () => {
      stripWidth = 3 * MIN_TAB_WIDTH + 2 * TAB_GAP;
      render(labelled({ activeId: "a", collapsed: false, unreadIds: [] }));
      expect(tabNames()).toEqual(["app a", "app b", "app c"]);
      expect(screen.getByRole("button", { name: "All open apps, 2 more" }).textContent).toBe("+2");
    });

    it("moves a hidden active tab into the last slot", () => {
      stripWidth = 3 * MIN_TAB_WIDTH + 2 * TAB_GAP;
      render(labelled({ activeId: "e", collapsed: false, unreadIds: [] }));
      expect(tabNames()).toEqual(["app a", "app b", "app e"]);
    });

    it("keeps one fit near the threshold when the first tab has a dot and a later one is active", () => {
      // A drawn tab is 34 px around what it holds; a name is 8 px a letter,
      // a dot 6. "app a" with its dot is 80 px, the others 74.
      const widthOf = (el: Element): number => {
        if (el.matches("[data-tool-tab]")) {
          const trigger = el.querySelector("[role=tab]")!;
          return 34 + [...trigger.children].reduce((sum, child) => sum + widthOf(child), 0);
        }
        if (el.matches(".size-1\\.5")) return 6;
        if (el.matches("[data-tool-tab-label], [data-measure-label]")) {
          return (el.textContent ?? "").length * 8;
        }
        return 0;
      };
      rs.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
        this: Element,
      ) {
        return {
          width: widthOf(this),
          height: 0,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
        } as DOMRect;
      });
      // a + e = 80 + 4 + 74. Measured with "a"'s dot taken for every tab, the
      // strip flipped between [a, e] and [e] until React gave up.
      stripWidth = 160;
      render(labelled({ activeId: "e", collapsed: false, unreadIds: ["a"] }));
      expect(tabNames()).toEqual(["app a", "app e"]);
      rs.restoreAllMocks();
    });

    it("lists every tab on the menu and keeps the plain label when all fit", async () => {
      const user = userEvent.setup();
      stripWidth = 3 * MIN_TAB_WIDTH + 2 * TAB_GAP;
      const { unmount } = render(labelled({ activeId: "a", collapsed: false, unreadIds: [] }));
      await user.click(screen.getByRole("button", { name: "All open apps, 2 more" }));
      expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "app a",
        "app b",
        "app c",
        "app d",
        "app e",
      ]);
      unmount();
      stripWidth = 5000;
      render(labelled({ activeId: "a", collapsed: false, unreadIds: [] }));
      expect(tabNames()).toHaveLength(5);
      expect(screen.getByRole("button", { name: "All open apps" }).textContent).toBe("");
    });
  });

  it("adjusts and resets the separator with the keyboard without losing chat input", async () => {
    const user = userEvent.setup();
    render(workspace({ activeId: "a", collapsed: false, unreadIds: [] }));
    await user.type(screen.getByRole("textbox", { name: "Chat draft" }), "keep this prompt");
    const separator = screen.getByRole("separator");
    const initial = Number(separator.getAttribute("aria-valuenow"));
    separator.focus();
    await user.keyboard("{ArrowRight}");
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(initial + 24);
    expect(Number(localStorage.getItem("rome:tool-chat-ratio"))).toBeGreaterThan(0.4);
    await user.keyboard("{Home}");
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(initial);
    expect((screen.getByRole("textbox", { name: "Chat draft" }) as HTMLInputElement).value).toBe(
      "keep this prompt",
    );
  });

  it("shows one surface at a time in a narrow workspace", () => {
    viewportWidth = 390;
    const view = { activeId: "a", collapsed: false, unreadIds: [] };
    const { rerender } = render(workspace(view));
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Chat draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat", exact: true })).toBeNull();
    rerender(workspace({ ...view, collapsed: true }));
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
    expect(screen.queryByRole("tabpanel")).toBeNull();
  });

  it("links the active tool to its full page and refreshes it before opening", async () => {
    const user = userEvent.setup();
    const onOpenIntent = rs.fn();
    const { rerender } = render(
      workspace(
        { activeId: "a", collapsed: false, unreadIds: [] },
        placements,
        rs.fn(),
        onOpenIntent,
      ),
    );
    const link = screen.getByRole("link", { name: "Open desktop in new tab" });
    expect(link.getAttribute("href")).toBe("/desktop");
    expect(link.getAttribute("target")).toBe("_blank");
    await user.hover(link);
    expect(onOpenIntent).toHaveBeenCalledWith(placements[0]);

    rerender(workspace({ activeId: "b", collapsed: false, unreadIds: [] }));
    expect(screen.queryByRole("link", { name: /in new tab/ })).toBeNull();
  });
});

describe("ToolWorkspace in the Mac app's title bar", () => {
  function inTitlebar(view: ToolView) {
    return (
      <SlotProvider>
        <div data-testid="titlebar-end">
          <SlotOutlet name={TITLEBAR_END_SLOT} />
        </div>
        {workspace(view)}
      </SlotProvider>
    );
  }

  it("moves the tabs up over the panel, as wide as the panel", () => {
    render(inTitlebar({ activeId: "a", collapsed: false, unreadIds: [] }));

    const end = screen.getByTestId("titlebar-end");
    expect(end.querySelector('[role="tablist"]')).not.toBeNull();
    const header = end.firstElementChild?.firstElementChild as HTMLElement;
    const chat = screen.getByTestId("workspace-chat");
    // The separator is the one pixel between the chat and the panel.
    expect(Number.parseFloat(header.style.width) + Number.parseFloat(chat.style.width) + 1).toBe(
      viewportWidth,
    );
  });

  it("fits the tabs to the strip in the title bar too", () => {
    stripWidth = MIN_TAB_WIDTH;
    render(inTitlebar({ activeId: "b", collapsed: false, unreadIds: [] }));
    const end = screen.getByTestId("titlebar-end");
    expect(Array.from(end.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)).toEqual([
      "projects",
    ]);
    expect(screen.getByRole("button", { name: "All open apps, 1 more" })).toBeTruthy();
  });

  it("leaves the title bar when the panel is collapsed", () => {
    render(inTitlebar({ activeId: "a", collapsed: true, unreadIds: [] }));
    expect(screen.getByTestId("titlebar-end").querySelector('[role="tablist"]')).toBeNull();
  });
});

// Stands in for the chat: it owns the trace and hands it to the pane, the way
// Chat does. Its "Open trace" button is the trace trigger.
function TraceOwner({ streaming = false, id = "chat" }: { streaming?: boolean; id?: string }) {
  const host = useToolTrace();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("first");
  const set = host?.set;
  useEffect(() => {
    set?.(id, open ? { streaming, onClose: () => setOpen(false) } : null);
  }, [set, id, open, streaming]);
  useEffect(() => () => set?.(id, null), [set, id]);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setLabel((previous) => (open ? `${previous}+` : previous));
          setOpen(true);
          host?.reveal();
        }}
      >
        Open trace {id}
      </button>
      {open && host?.outlet && createPortal(<p>Trace body {label}</p>, host.outlet)}
    </>
  );
}

function TraceHarness({
  initial = { activeId: "a", collapsed: false, unreadIds: [] },
  items = placements,
  selectTool = rs.fn(),
  setCollapsed = rs.fn(),
  addWidget = rs.fn(),
  removeWidget = rs.fn(),
  streaming = false,
  withSecondOwner = false,
}: {
  initial?: ToolView;
  items?: WidgetPlacement[];
  selectTool?: (id: string) => void;
  setCollapsed?: (collapsed: boolean) => void;
  addWidget?: () => void;
  removeWidget?: (id: string) => void;
  streaming?: boolean;
  withSecondOwner?: boolean;
}) {
  const [view, setView] = useState(initial);
  return (
    <ToolWorkspace
      placements={items}
      view={view}
      selectTool={(id) => {
        selectTool(id);
        setView((v) => ({ ...v, activeId: id, collapsed: false }));
      }}
      setCollapsed={(collapsed) => {
        setCollapsed(collapsed);
        setView((v) => ({ ...v, collapsed }));
      }}
      addWidget={addWidget}
      removeWidget={removeWidget}
      label={(widget) => widget.type}
      icon={() => null}
      content={(widget) => <ToolContent id={widget.id} />}
      fullHref={() => null}
    >
      <input aria-label="Chat draft" />
      <button type="button" onClick={() => setView((v) => ({ ...v, collapsed: false }))}>
        Expand pane
      </button>
      <TraceOwner streaming={streaming} />
      {withSecondOwner && <TraceOwner id="pinned" />}
    </ToolWorkspace>
  );
}

// The pane's own tabs, without the task chats' row inside the Tasks tab.
const tabNames = () =>
  screen
    .getAllByRole("tab")
    .filter((tab) => !tab.closest("[data-task-chat-tabs]"))
    .map((tab) => tab.textContent);

describe("ToolWorkspace Trace tab", () => {
  it("puts the Trace tab before the app tabs and selects it", async () => {
    const user = userEvent.setup();
    render(<TraceHarness />);
    expect(tabNames()).toEqual(["desktop", "projects"]);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));

    expect(tabNames()).toEqual(["Trace", "desktop", "projects"]);
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "desktop" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(screen.getByText("Trace body first")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Draft a" })).toBeNull();
  });

  it("shows the trace over a collapsed pane without writing the pane state, and falls back on close", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TraceHarness
        initial={{ activeId: "a", collapsed: true, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    expect(screen.queryByRole("tab")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Trace body first")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close Trace" }));
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Trace body first")).toBeNull();
    expect(setCollapsed).not.toHaveBeenCalled();
  });

  it("returns to the app tab that was active before the trace, leaving the pane open", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TraceHarness
        initial={{ activeId: "b", collapsed: false, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("button", { name: "Close Trace" }));

    expect(tabNames()).toEqual(["desktop", "projects"]);
    expect(screen.getByRole("tab", { name: "projects" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("textbox", { name: "Draft b" })).toBeTruthy();
    expect(setCollapsed).not.toHaveBeenCalled();
  });

  it("closes from the Delete key like any other tab", async () => {
    const user = userEvent.setup();
    render(<TraceHarness />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    screen.getByRole("tab", { name: "Trace" }).focus();
    await user.keyboard("{Delete}");
    expect(tabNames()).toEqual(["desktop", "projects"]);
  });

  it("is view state only: nothing reaches the layout or storage", async () => {
    const user = userEvent.setup();
    const selectTool = rs.fn();
    const addWidget = rs.fn();
    const removeWidget = rs.fn();
    render(
      <TraceHarness selectTool={selectTool} addWidget={addWidget} removeWidget={removeWidget} />,
    );
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("tab", { name: "desktop" }));
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    await user.click(screen.getByRole("button", { name: "Close Trace" }));

    expect(selectTool.mock.calls.flat()).toEqual(["a"]);
    expect(addWidget).not.toHaveBeenCalled();
    expect(removeWidget).not.toHaveBeenCalled();
    expect(Object.keys(localStorage).filter((key) => key !== "rome:tool-chat-ratio")).toEqual([]);
  });

  it("keeps one tab: a second trace replaces the content and selects it again", async () => {
    const user = userEvent.setup();
    render(<TraceHarness />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("tab", { name: "desktop" }));
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    expect(screen.getAllByRole("tab", { name: "Trace" })).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Trace body first+")).toBeTruthy();
  });

  it("lets another owner displace the open trace", async () => {
    const user = userEvent.setup();
    render(<TraceHarness withSecondOwner />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("button", { name: "Open trace pinned" }));

    expect(screen.getAllByRole("tab", { name: "Trace" })).toHaveLength(1);
    expect(screen.getAllByText(/Trace body/)).toHaveLength(1);
  });

  it("collapsing the pane keeps the tab, and expanding shows it again", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(<TraceHarness setCollapsed={setCollapsed} />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("button", { name: "Hide apps" }));
    expect(setCollapsed).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("tabpanel")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Expand pane" }));
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Trace body first")).toBeTruthy();
  });

  it("collapses a pane the trace held open when its own collapse button is used", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TraceHarness
        initial={{ activeId: "a", collapsed: true, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("button", { name: "Hide apps" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(setCollapsed).toHaveBeenCalledWith(true);
  });

  it("keeps the hidden Trace panel's scroller out of display:none", async () => {
    const user = userEvent.setup();
    render(<TraceHarness />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    const panel = screen.getByText("Trace body first").closest('[role="tabpanel"]') as HTMLElement;
    expect(panel.style.visibility).toBe("");

    await user.click(screen.getByRole("tab", { name: "desktop" }));
    expect(panel.style.visibility).toBe("hidden");
    expect(panel.style.display).toBe("");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("Trace body first")).toBeTruthy();
  });

  it("marks a streaming trace Live on its tab", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TraceHarness streaming />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    expect(screen.getByLabelText("Live")).toBeTruthy();
    rerender(<TraceHarness streaming={false} />);
    expect(screen.queryByLabelText("Live")).toBeNull();
  });

  it("does not offer the empty apps state for a trace alone, and falls back to collapsed on close", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TraceHarness
        items={[]}
        initial={{ activeId: null, collapsed: true, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    expect(screen.queryByRole("heading", { name: "No apps open" })).toBeNull();
    expect(tabNames()).toEqual(["Trace"]);
    expect(screen.getByText("Trace body first")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Close Trace" }));
    expect(setCollapsed).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("heading", { name: "No apps open" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("keeps the pane open for an app the user chose while the trace held it open", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TraceHarness
        initial={{ activeId: "a", collapsed: true, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("tab", { name: "projects" }));
    await user.click(screen.getByRole("button", { name: "Close Trace" }));

    expect(setCollapsed).not.toHaveBeenCalled();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "projects" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("covers the chat below the compact width, like an app", async () => {
    viewportWidth = 390;
    const user = userEvent.setup();
    render(<TraceHarness initial={{ activeId: "a", collapsed: true, unreadIds: [] }} />);
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));

    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Chat draft" })).toBeNull();
    expect(screen.getByText("Trace body first")).toBeTruthy();
  });

  it("shares the apps split: chat left, pane right, one separator", async () => {
    const user = userEvent.setup();
    render(<TraceHarness initial={{ activeId: "a", collapsed: true, unreadIds: [] }} />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));

    const separator = screen.getByRole("separator");
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(
      Math.round((viewportWidth - 1) * 0.4),
    );
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
  });

  it("shows the Trace tab in the Mac app's title bar", async () => {
    const user = userEvent.setup();
    render(
      <SlotProvider>
        <div data-testid="titlebar-end">
          <SlotOutlet name={TITLEBAR_END_SLOT} />
        </div>
        <TraceHarness initial={{ activeId: "a", collapsed: true, unreadIds: [] }} />
      </SlotProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));

    const end = screen.getByTestId("titlebar-end");
    expect(end.querySelector('[role="tab"]')?.textContent).toBe("Trace");
  });
});

// The same pane driven by the real, session-scoped tool view store.
describe("ToolWorkspace Trace tab against the saved tool view", () => {
  function StoreWorkspace({ owner = true }: { owner?: boolean }) {
    const cells = store.useFreeCells();
    return (
      <ToolWorkspace
        placements={cells.placements}
        view={cells.toolView}
        activations={cells.toolActivations}
        selectTool={cells.selectTool}
        setCollapsed={cells.setToolsCollapsed}
        addWidget={cells.addWidget}
        removeWidget={cells.removeWidget}
        label={(widget) => widget.targetId ?? widget.type}
        icon={() => null}
        content={(widget) => <ToolContent id={widget.id} />}
        fullHref={() => null}
      >
        {owner && <TraceOwner />}
      </ToolWorkspace>
    );
  }

  const savedViews = () =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter((key) => key.startsWith("rome:tool-view:"))
        .map((key) => [key, localStorage.getItem(key)]),
    );

  beforeEach(() => {
    rs.stubGlobal("fetch", rs.fn().mockResolvedValue(new Response(null, { status: 200 })));
    store.setActiveSession("reset");
    store.setActiveSession(null);
    localStorage.clear();
  });

  it("never writes the pane's saved state when a trace opens over a collapsed pane", async () => {
    const user = userEvent.setup();
    store.setActiveSession("A");
    render(<StoreWorkspace />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));

    expect(screen.getByRole("tab", { name: "Trace" })).toBeTruthy();
    expect(screen.getByText("Trace body first")).toBeTruthy();
    expect(savedViews()).toEqual({});
  });

  it("returns to collapsed with nothing persisted when the trace closes", async () => {
    const user = userEvent.setup();
    store.setActiveSession("A");
    render(<StoreWorkspace />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    await user.click(screen.getByRole("button", { name: "Close Trace" }));

    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(savedViews()).toEqual({});
  });

  it("leaves another session's expanded pane alone when the old chat unregisters after a switch", async () => {
    const user = userEvent.setup();
    store.setActiveSession("B");
    act(() => store.setToolsCollapsed(false));
    const before = savedViews();
    expect(JSON.parse(before["rome:tool-view:B"] as string).collapsed).toBe(false);

    store.setActiveSession("A");
    const { rerender } = render(<StoreWorkspace />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    // FreeGrid switches the store first; the old chat's cleanup runs after.
    act(() => store.setActiveSession("B"));
    rerender(<StoreWorkspace owner={false} />);

    expect(screen.queryByRole("tab", { name: "Trace" })).toBeNull();
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(savedViews()).toEqual(before);
  });

  it("saves the pane open when the user picks an app tab while the trace holds it open", async () => {
    const user = userEvent.setup();
    store.setActiveSession("A");
    act(() => {
      store.autoPlaceProjects(true);
      store.setToolsCollapsed(true);
    });
    expect(JSON.parse(savedViews()["rome:tool-view:A"] as string).collapsed).toBe(true);
    render(<StoreWorkspace />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    expect(JSON.parse(savedViews()["rome:tool-view:A"] as string).collapsed).toBe(true);

    await user.click(screen.getByRole("tab", { name: "projects" }));
    expect(JSON.parse(savedViews()["rome:tool-view:A"] as string).collapsed).toBe(false);
    await user.click(screen.getByRole("button", { name: "Close Trace" }));
    expect(screen.getByRole("separator")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "projects" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  const selected = (name: string) =>
    screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";

  async function openTraceOverApps(user: ReturnType<typeof userEvent.setup>) {
    store.setActiveSession("A");
    act(() => {
      store.autoPlaceApp("notes", "r1");
      store.autoPlaceApp("mail", "r1");
      store.setToolsCollapsed(false);
    });
    render(<StoreWorkspace />);
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));
    expect(selected("Trace")).toBe(true);
  }

  it("keeps Trace selected when the agent re-places the active app under a new id", async () => {
    const user = userEvent.setup();
    await openTraceOverApps(user);
    act(() => {
      store.applyAgentPlacement("p1", "mail", "r2");
    });

    expect(selected("Trace")).toBe(true);
    expect(screen.getByText("Trace body first")).toBeTruthy();
  });

  it("shows the app when the user opens one from a chat link while Trace is selected", async () => {
    const user = userEvent.setup();
    await openTraceOverApps(user);
    act(() => {
      store.autoPlaceApp("mail", "r2", undefined, true);
    });

    expect(selected("Trace")).toBe(false);
    expect(selected("mail")).toBe(true);
  });

  it("keeps Trace selected when background apps close, with no empty state", async () => {
    const user = userEvent.setup();
    await openTraceOverApps(user);
    await user.click(screen.getByRole("button", { name: "Close notes" }));
    expect(selected("Trace")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Close mail" }));

    expect(tabNames()).toEqual(["Trace"]);
    expect(selected("Trace")).toBe(true);
    expect(screen.queryByRole("heading", { name: "No apps open" })).toBeNull();
    expect(screen.getByText("Trace body first")).toBeTruthy();
  });

  it("selects an app when the user clicks its tab, and when they add one", async () => {
    const user = userEvent.setup();
    await openTraceOverApps(user);
    await user.click(screen.getByRole("tab", { name: "notes" }));
    expect(selected("notes")).toBe(true);
    expect(selected("Trace")).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(selected("Trace")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Open an app" }));
    await user.click(screen.getByRole("option", { name: "Projects" }));
    expect(selected("Trace")).toBe(false);
    expect(selected("projects")).toBe(true);
  });
});

// Stands in for the Concierge chat's pill: it asks the pane for the Tasks tab.
function TasksOwner() {
  const pane = useToolTasks();
  return (
    <>
      <button type="button" onClick={() => pane?.show("chat-1")}>
        Show tasks
      </button>
      <button type="button" onClick={() => pane?.hide()}>
        Hide tasks
      </button>
      <button type="button" onClick={() => pane?.openTask?.("chat-1", "task-9", "Book flights")}>
        Open task link
      </button>
      <button type="button" onClick={() => pane?.openTask?.("chat-1", "task-5")}>
        Open nameless task
      </button>
      <output data-testid="tasks-host">
        {JSON.stringify({
          active: pane?.active,
          compact: pane?.compact,
          ...(pane?.openTask ? { opensTasks: true } : {}),
        })}
      </output>
    </>
  );
}

function TasksHarness({
  initial = { activeId: "a", collapsed: false, unreadIds: [] },
  selectTool = rs.fn(),
  setCollapsed = rs.fn(),
  addWidget = rs.fn(),
  removeWidget = rs.fn(),
  withTrace = false,
  withTaskChat = false,
}: {
  initial?: ToolView;
  selectTool?: (id: string) => void;
  setCollapsed?: (collapsed: boolean) => void;
  addWidget?: () => void;
  removeWidget?: (id: string) => void;
  withTrace?: boolean;
  withTaskChat?: boolean;
}) {
  const [view, setView] = useState(initial);
  return (
    <ToolWorkspace
      placements={placements}
      view={view}
      selectTool={(id) => {
        selectTool(id);
        setView((v) => ({ ...v, activeId: id, collapsed: false }));
      }}
      setCollapsed={(collapsed) => {
        setCollapsed(collapsed);
        setView((v) => ({ ...v, collapsed }));
      }}
      addWidget={addWidget}
      removeWidget={removeWidget}
      label={(widget) => widget.type}
      icon={() => null}
      content={(widget) => <ToolContent id={widget.id} />}
      fullHref={() => null}
      taskChat={withTaskChat ? taskChat : undefined}
    >
      <input aria-label="Chat draft" />
      <TasksOwner />
      {withTrace && <TraceOwner />}
    </ToolWorkspace>
  );
}

const selected = (name: string) =>
  screen.getByRole("tab", { name }).getAttribute("aria-selected") === "true";
// Whether the text is on screen: mounted, and under nothing hidden.
const shows = (text: string) => {
  const el = screen.queryByText(text);
  return (
    el !== null &&
    !el.closest('[style*="display: none"]') &&
    !el.closest('[style*="visibility: hidden"]')
  );
};

// Stands in for the task chat the pane draws: whether it is on screen, its
// delete, and its name.
const chatMounts = rs.fn();
function TaskChatStandIn({ id, onGone }: { id: string; onGone: () => void }) {
  const inPane = useTaskChatInPane();
  useEffect(() => chatMounts(id), [id]);
  return (
    <>
      {inPane ? (
        <>
          <output data-testid={`active ${id}`}>{String(inPane.active)}</output>
          <button type="button" onClick={inPane.onClose}>
            Delete chat {id}
          </button>
          {inPane.actions
            ? createPortal(<button type="button">More for {id}</button>, inPane.actions)
            : null}
        </>
      ) : null}
      <p>Task chat {id}</p>
      <input aria-label={`Draft ${id}`} defaultValue="" />
      <button type="button" onClick={onGone}>
        Lose the chat
      </button>
    </>
  );
}
const taskChat = (id: string, onGone: () => void) => <TaskChatStandIn id={id} onGone={onGone} />;

describe("ToolWorkspace Tasks tab", () => {
  it("keeps the narrow chat visible until Tasks is requested and returns to it on close", async () => {
    viewportWidth = 390;
    const user = userEvent.setup();
    render(<TasksHarness initial={{ activeId: "a", collapsed: true, unreadIds: [] }} />);
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(screen.queryByRole("textbox", { name: "Chat draft" })).toBeNull();
    expect(screen.getByText("Task panel body chat-1")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close Tasks" }));
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("adds an ephemeral Tasks tab ahead of the apps and selects it, writing nothing to the layout", async () => {
    const user = userEvent.setup();
    const selectTool = rs.fn();
    const setCollapsed = rs.fn();
    const addWidget = rs.fn();
    const removeWidget = rs.fn();
    render(
      <TasksHarness
        selectTool={selectTool}
        setCollapsed={setCollapsed}
        addWidget={addWidget}
        removeWidget={removeWidget}
      />,
    );
    expect(tabNames()).toEqual(["desktop", "projects"]);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));

    expect(tabNames()).toEqual(["Tasks", "desktop", "projects"]);
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Task panel body chat-1")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "desktop" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(selectTool).not.toHaveBeenCalled();
    expect(setCollapsed).not.toHaveBeenCalled();
    expect(addWidget).not.toHaveBeenCalled();
    expect(removeWidget).not.toHaveBeenCalled();
    expect(JSON.parse(screen.getByTestId("tasks-host").textContent!)).toEqual({
      active: true,
      compact: false,
    });
  });

  it("is not part of the saved layout: nothing about it reaches storage", async () => {
    const user = userEvent.setup();
    render(<TasksHarness />);
    const before = JSON.stringify({ ...localStorage });
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(JSON.stringify({ ...localStorage })).toBe(before);
  });

  it("is removed by its close button and by the pill, and the app tab it covered comes back", async () => {
    const user = userEvent.setup();
    render(<TasksHarness />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Close Tasks" }));
    expect(tabNames()).toEqual(["desktop", "projects"]);
    expect(screen.queryByText("Task panel body chat-1")).toBeNull();
    expect(screen.getByRole("tab", { name: "desktop" }).getAttribute("aria-selected")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Hide tasks" }));
    expect(tabNames()).toEqual(["desktop", "projects"]);
  });

  it("stays when an app tab is chosen, and chosen again shows the list", async () => {
    const user = userEvent.setup();
    const selectTool = rs.fn();
    render(<TasksHarness selectTool={selectTool} />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("tab", { name: "projects" }));
    expect(selectTool).toHaveBeenCalledWith("b");
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("false");
    expect(JSON.parse(screen.getByTestId("tasks-host").textContent!).active).toBe(false);

    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Task panel body chat-1")).toBeTruthy();
  });

  it("shows over a collapsed pane without writing the pane state, and falls back when it goes", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TasksHarness
        initial={{ activeId: "a", collapsed: true, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    expect(screen.queryByRole("tabpanel")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(screen.getByText("Task panel body chat-1")).toBeTruthy();
    expect(setCollapsed).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close Tasks" }));
    expect(screen.queryByRole("tabpanel")).toBeNull();
    expect(setCollapsed).not.toHaveBeenCalled();
  });

  it("takes turns with the Trace tab, which behaves as before", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTrace />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Open trace chat" }));

    expect(tabNames()).toEqual(["Trace", "Tasks", "desktop", "projects"]);
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("Trace body first")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Trace" }).getAttribute("aria-selected")).toBe("false");

    await user.click(screen.getByRole("button", { name: "Close Trace" }));
    expect(tabNames()).toEqual(["Tasks", "desktop", "projects"]);
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens a task chat in a Chat tab beside Tasks, and Tasks and Chat switch between them", async () => {
    const user = userEvent.setup();
    listMounts.mockClear();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    // No Chat tab until a task chat is opened.
    expect(tabNames()).toEqual(["Tasks", "desktop", "projects"]);
    await user.click(screen.getByRole("button", { name: "Open task row" }));

    expect(tabNames()).toEqual(["Tasks", "Review PRs", "desktop", "projects"]);
    expect(selected("Review PRs")).toBe(true);
    expect(shows("Task chat task-7")).toBe(true);
    expect(shows("Task panel body chat-1")).toBe(false);
    // The Concierge chat beside it stays.
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(shows("Task panel body chat-1")).toBe(true);
    expect(shows("Task chat task-7")).toBe(false);
    await user.click(screen.getByRole("tab", { name: "Review PRs" }));
    expect(shows("Task chat task-7")).toBe(true);
    expect(listMounts).toHaveBeenCalledTimes(1);
  });

  it("makes the tab the task chat's header: its status mark, its menu and a new-tab link", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Open task row" }));
    const tab = screen.getByRole("tab", { name: "Review PRs" });
    // The mark its task link draws: it needs its owner.
    expect(tab.querySelector("svg.text-warning\\/80")).not.toBeNull();
    const row = () => document.querySelector("[data-tool-tab-actions]")!;
    expect(row().textContent).toBe("More for task-7");
    expect(
      screen.getByRole("link", { name: "Open Review PRs in new tab" }).getAttribute("href"),
    ).toBe("/chat/task-7");
    // Another tab chosen: the task chat's buttons and its link go.
    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(row().textContent).toBe("");
    expect(screen.queryByRole("link", { name: "Open Review PRs in new tab" })).toBeNull();
  });

  it("shows a tab's close button on the chosen tab, and on another only on hover or focus", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Open task row" }));
    const close = (name: string) => screen.getByRole("button", { name: `Close ${name}` });
    expect(close("Review PRs").className).not.toContain("opacity-0");
    expect(close("Tasks").className).toContain("opacity-0");
    expect(close("Tasks").className).toContain("group-hover/tab:opacity-100");
    expect(close("Tasks").className).toContain("touch-show");
  });

  it("shows only the task chat opened last: another replaces it in the same tab", async () => {
    const user = userEvent.setup();
    chatMounts.mockClear();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Open task row" }));
    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    expect(tabNames()).toEqual(["Tasks", "Book flights", "desktop", "projects"]);
    expect(shows("Task chat task-9")).toBe(true);
    expect(screen.queryByText("Task chat task-7")).toBeNull();
    expect(chatMounts.mock.calls).toEqual([["task-7"], ["task-9"]]);
  });

  it("opens a linked task chat over a collapsed pane, with the Tasks tab beside it", async () => {
    const user = userEvent.setup();
    const setCollapsed = rs.fn();
    render(
      <TasksHarness
        withTaskChat
        initial={{ activeId: "a", collapsed: true, unreadIds: [] }}
        setCollapsed={setCollapsed}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    expect(tabNames()).toEqual(["Tasks", "Book flights", "desktop", "projects"]);
    expect(shows("Task chat task-9")).toBe(true);
    expect(setCollapsed).not.toHaveBeenCalled();

    // The header's Tasks button shows the list; the Chat tab stays.
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(selected("Tasks")).toBe(true);
    expect(tabNames()).toEqual(["Tasks", "Book flights", "desktop", "projects"]);
  });

  it("closes the Chat tab on its own, and when the chat is not found or deleted", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.click(screen.getByRole("button", { name: "Close Book flights" }));
    expect(tabNames()).toEqual(["Tasks", "desktop", "projects"]);

    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.click(screen.getByRole("button", { name: "Lose the chat" }));
    expect(tabNames()).toEqual(["Tasks", "desktop", "projects"]);

    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.click(screen.getByRole("button", { name: "Delete chat task-9" }));
    expect(tabNames()).toEqual(["Tasks", "desktop", "projects"]);
    expect(screen.getByRole("textbox", { name: "Chat draft" })).toBeTruthy();
  });

  it("keeps the Chat tab when the Tasks tab closes, and closes both when the chat goes", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.click(screen.getByRole("button", { name: "Close Tasks" }));
    expect(tabNames()).toEqual(["Book flights", "desktop", "projects"]);
    // The Concierge chat going asks the pane to hide its tabs.
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.click(screen.getByRole("button", { name: "Hide tasks" }));
    expect(tabNames()).toEqual(["desktop", "projects"]);
  });

  it("keeps the task chat and its draft mounted while another tab shows", async () => {
    const user = userEvent.setup();
    chatMounts.mockClear();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.type(screen.getByRole("textbox", { name: "Draft task-9" }), "half a reply");
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(shows("Task chat task-9")).toBe(false);
    await user.click(screen.getByRole("tab", { name: "desktop" }));
    await user.click(screen.getByRole("tab", { name: "Book flights" }));
    expect(shows("Task chat task-9")).toBe(true);
    expect((screen.getByRole("textbox", { name: "Draft task-9" }) as HTMLInputElement).value).toBe(
      "half a reply",
    );
    expect(chatMounts).toHaveBeenCalledTimes(1);
  });

  it("hides the Chat tab with visibility and zero opacity, not display, so it keeps its scroll", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    const tab = document
      .querySelector<HTMLElement>('[data-task-chat-pane="task-9"]')!
      .closest<HTMLElement>('[role="tabpanel"]')!;
    expect(tab.style.visibility).toBe("hidden");
    // A descendant can turn `visibility` back on, but not opacity.
    expect(tab.style.opacity).toBe("0");
    expect(tab.style.display).toBe("");
    expect(tab.hasAttribute("inert")).toBe(true);
  });

  it("tells the task chat whether it is on screen, so a hidden one stops listening", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    const active = () => screen.getByTestId("active task-9").textContent;
    expect(active()).toBe("true");
    await user.click(screen.getByRole("tab", { name: "Tasks" }));
    expect(active()).toBe("false");
    await user.click(screen.getByRole("tab", { name: "Book flights" }));
    expect(active()).toBe("true");
    await user.click(screen.getByRole("tab", { name: "desktop" }));
    expect(active()).toBe("false");
  });

  it("names the Chat tab for its task chat, and follows its own name once read", async () => {
    const user = userEvent.setup();
    const view = render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open task link" }));
    // At once, the name it was opened with.
    expect(tabNames()).toEqual(["Tasks", "Book flights", "desktop", "projects"]);
    // The chat's own name wins once read, as after a rename.
    sessionNames.set("task-9", "Book direct flights to Lisbon");
    view.rerender(<TasksHarness withTaskChat />);
    expect(tabNames()).toEqual(["Tasks", "Book direct flights to Lisbon", "desktop", "projects"]);
    // A long name is cut by the tab, and its full text is the tab's title.
    expect(screen.getByRole("tab", { name: "Book direct flights to Lisbon" }).className).toContain(
      "max-w-48",
    );
    // Opening another task chat renames the one tab.
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Open task row" }));
    expect(tabNames()).toEqual(["Tasks", "Review PRs", "desktop", "projects"]);
  });

  it("calls the Chat tab Chat while its task chat has no name", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Open nameless task" }));
    expect(tabNames()).toEqual(["Tasks", "Chat", "desktop", "projects"]);
  });

  it("opens task chats as pages once the pane takes the whole width", async () => {
    const user = userEvent.setup();
    render(<TasksHarness withTaskChat />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(screen.getByRole("button", { name: "Open task row" })).toBeTruthy();
    resizeWorkspace(500);
    // The row keeps its link to the page, and the pill opens none in place.
    expect(screen.queryByRole("button", { name: "Open task row" })).toBeNull();
    expect(JSON.parse(screen.getByTestId("tasks-host").textContent!).opensTasks).toBeUndefined();
    resizeWorkspace(1200);
    expect(screen.getByRole("button", { name: "Open task row" })).toBeTruthy();
  });

  it("offers no in-place task chat where the pane cannot draw one", async () => {
    const user = userEvent.setup();
    render(<TasksHarness />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    expect(screen.queryByRole("button", { name: "Open task row" })).toBeNull();
    expect(JSON.parse(screen.getByTestId("tasks-host").textContent!).opensTasks).toBeUndefined();
  });

  it("tells the pill when the pane would take the whole width", async () => {
    viewportWidth = 500;
    render(<TasksHarness />);
    expect(JSON.parse(screen.getByTestId("tasks-host").textContent!).compact).toBe(true);
    viewportWidth = 1200;
    cleanup();
    render(<TasksHarness />);
    expect(JSON.parse(screen.getByTestId("tasks-host").textContent!).compact).toBe(false);
  });
});

// Stands in for the chat's header button and a message link: it asks the pane for the Outputs tab.
function OutputsOwner() {
  const pane = useToolOutputs();
  return (
    <>
      <button type="button" onClick={() => pane?.show("chat-1")}>
        Show outputs
      </button>
      <button type="button" onClick={() => pane?.show("chat-1", "out-2")}>
        Open output
      </button>
      <button type="button" onClick={() => pane?.show("chat-1", undefined, { taskChats: true })}>
        Show Concierge outputs
      </button>
      <output data-testid="outputs-host">{JSON.stringify({ active: pane?.active })}</output>
    </>
  );
}

function OutputsHarness({
  withTasks = false,
  withTaskChat = false,
}: {
  withTasks?: boolean;
  withTaskChat?: boolean;
}) {
  const [view, setView] = useState<ToolView>({ activeId: "a", collapsed: false, unreadIds: [] });
  return (
    <ToolWorkspace
      placements={placements}
      view={view}
      selectTool={(id) => setView((v) => ({ ...v, activeId: id, collapsed: false }))}
      setCollapsed={(collapsed) => setView((v) => ({ ...v, collapsed }))}
      addWidget={rs.fn()}
      removeWidget={rs.fn()}
      label={(widget) => widget.type}
      icon={() => null}
      content={(widget) => <ToolContent id={widget.id} />}
      fullHref={() => null}
      taskChat={withTaskChat ? taskChat : undefined}
    >
      <OutputsOwner />
      {withTasks && <TasksOwner />}
    </ToolWorkspace>
  );
}

describe("ToolWorkspace Outputs tab", () => {
  it("adds an Outputs tab beside the other built-in tabs and selects it", async () => {
    const user = userEvent.setup();
    render(<OutputsHarness withTasks />);
    await user.click(screen.getByRole("button", { name: "Show tasks" }));
    await user.click(screen.getByRole("button", { name: "Show outputs" }));
    expect(tabNames()).toEqual(["Tasks", "Outputs", "desktop", "projects"]);
    expect(screen.getByRole("tab", { name: "Outputs" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Tasks" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("Outputs body chat-1 none")).toBeTruthy();
    expect(JSON.parse(screen.getByTestId("outputs-host").textContent!)).toEqual({ active: true });
  });

  it("opens the task chat an output came from in the Chat tab", async () => {
    const user = userEvent.setup();
    render(<OutputsHarness withTaskChat />);
    // Only a Concierge chat's outputs come from task chats.
    await user.click(screen.getByRole("button", { name: "Show outputs" }));
    expect(screen.queryByRole("button", { name: "Open source task" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show Concierge outputs" }));
    await user.click(screen.getByRole("button", { name: "Open source task" }));
    expect(tabNames()).toEqual(["Tasks", "Q3 report", "Outputs", "desktop", "projects"]);
    expect(selected("Q3 report")).toBe(true);
    expect(shows("Task chat task-8")).toBe(true);
  });

  it("opens the file a link names inside the Outputs tab, with no tab of its own", async () => {
    const user = userEvent.setup();
    render(<OutputsHarness />);
    await user.click(screen.getByRole("button", { name: "Open output" }));
    expect(tabNames()).toEqual(["Outputs", "desktop", "projects"]);
    expect(selected("Outputs")).toBe(true);
    expect(shows("Outputs body chat-1 out-2")).toBe(true);
    // The file's buttons are its header's, in the Outputs page: none in the tab row.
    expect(document.querySelector("[data-tool-tab-actions]")!.textContent).toBe("");
    await user.click(screen.getByRole("button", { name: "Close Outputs" }));
    expect(tabNames()).toEqual(["desktop", "projects"]);
    expect(selected("desktop")).toBe(true);
  });
});
