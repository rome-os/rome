// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import i18n from "@/i18n";
import { ToolWorkspace } from "./ToolWorkspace";
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
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
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

function workspace(view: ToolView, items = placements, addWidget = rs.fn()) {
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
});
