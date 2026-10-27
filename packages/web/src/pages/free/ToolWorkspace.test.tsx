// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import i18n from "@/i18n";
import { SlotOutlet, SlotProvider } from "@/components/slot";
import { TITLEBAR_END_SLOT } from "@/shell/DesktopTitlebar";
import { ToolWorkspace } from "./ToolWorkspace";
import { useToolTrace } from "./tool-trace";
import * as store from "./use-free-cells";
import type { ToolView, WidgetPlacement } from "./use-free-cells";

rs.mock("@/hooks/use-apps", () => ({ useApps: () => ({ apps: [] }) }));

let viewportWidth = 1200;
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
  localStorage.clear();
  viewportWidth = 1200;
  rs.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") === "tool-workspace") {
          this.callback(
            [{ target, contentRect: { width: viewportWidth } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
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
) {
  return (
    <ToolWorkspace
      placements={items}
      view={view}
      selectTool={rs.fn()}
      setCollapsed={rs.fn()}
      addWidget={addWidget}
      removeWidget={rs.fn()}
      label={(widget) => widget.type}
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

const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

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
