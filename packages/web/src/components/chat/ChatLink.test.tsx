// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ChatLink } from "./ChatLink";
import {
  WorkspaceStoreContext,
  createWorkspaceStore,
  type WorkspaceStore,
} from "@/pages/free/workspace-store";
import {
  WorkspaceEventBusContext,
  createWorkspaceEventBus,
  type WorkspaceEventBus,
} from "@/pages/free/workspace-event-bus";

const autoPlaceApp = rs.fn();
rs.mock("@/pages/free/use-free-cells", () => ({
  autoPlaceApp: (...args: unknown[]) => autoPlaceApp(...args),
}));

afterEach(() => {
  cleanup();
  autoPlaceApp.mockClear();
});

function renderInWorkspace(
  ui: React.ReactElement,
  { store, bus }: { store: WorkspaceStore; bus: WorkspaceEventBus },
) {
  return render(
    <MemoryRouter>
      <WorkspaceEventBusContext.Provider value={bus}>
        <WorkspaceStoreContext.Provider value={store}>{ui}</WorkspaceStoreContext.Provider>
      </WorkspaceEventBusContext.Provider>
    </MemoryRouter>,
  );
}

describe("ChatLink", () => {
  it("opens the projects panel and follows the file for a /projects link", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(<ChatLink href="/projects/default/image-summary-39.png">image</ChatLink>, {
      store,
      bus,
    });
    fireEvent.click(screen.getByText("image"));

    expect(opened).toEqual([{ paths: ["/projects/default/image-summary-39.png"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/default/image-summary-39.png");
  });

  it("decodes a percent-encoded /projects href into a logical path", () => {
    // The markdown renderer percent-encodes non-ASCII/spaced hrefs; the follow
    // signal must carry the decoded logical path or /resolve misses the file.
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="/projects/default/%E7%A0%94%E7%A9%B6%E6%96%B9%E6%A1%88%20v8.docx">
        doc
      </ChatLink>,
      { store, bus },
    );
    fireEvent.click(screen.getByText("doc"));

    expect(opened).toEqual([{ paths: ["/projects/default/研究方案 v8.docx"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/default/研究方案 v8.docx");
  });

  it("keeps a malformed percent sequence verbatim instead of throwing", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/projects/default/100%-done.txt">pct</ChatLink>, {
      store,
      bus,
    });
    fireEvent.click(screen.getByText("pct"));

    expect(store.get("followTargetPath")).toBe("/projects/default/100%-done.txt");
  });

  it("never turns an encoded separator (%2F) into a real path component", () => {
    // Parity with decodeFileBrowserRoutePath: an encoded `/` inside a segment
    // is invalid, so the href passes through verbatim instead of following a
    // synthesized `a/b.txt` path the full-page route would reject.
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/projects/default/a%2Fb.txt">slash</ChatLink>, {
      store,
      bus,
    });
    fireEvent.click(screen.getByText("slash"));

    expect(store.get("followTargetPath")).toBe("/projects/default/a%2Fb.txt");
  });

  it("never turns an encoded dot-segment (%2E%2E) into a traversal path", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/projects/default/%2E%2E/secret.txt">dots</ChatLink>, {
      store,
      bus,
    });
    fireEvent.click(screen.getByText("dots"));

    expect(store.get("followTargetPath")).toBe("/projects/default/%2E%2E/secret.txt");
  });

  it("opens the app tile for an /apps link", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/apps/calendar">calendar</ChatLink>, { store, bus });
    fireEvent.click(screen.getByText("calendar"));

    expect(autoPlaceApp).toHaveBeenCalledWith("calendar", undefined, undefined);
  });

  it("preserves the in-app sub-route for a deep /apps link", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/apps/calendar/week/2024-06">cal</ChatLink>, { store, bus });
    fireEvent.click(screen.getByText("cal"));

    expect(autoPlaceApp).toHaveBeenCalledWith("calendar", "week/2024-06", undefined);
  });

  it("preserves query params for an /apps link", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/apps/connector?connector=gmail&status=ok">go</ChatLink>, {
      store,
      bus,
    });
    fireEvent.click(screen.getByText("go"));

    expect(autoPlaceApp).toHaveBeenCalledWith("connector", undefined, {
      connector: "gmail",
      status: "ok",
    });
  });

  it("leaves the /apps index page to react-router (no app tile)", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/apps">apps</ChatLink>, { store, bus });
    const link = screen.getByText("apps") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(link.getAttribute("href")).toBe("/apps");
    expect(autoPlaceApp).not.toHaveBeenCalled();
  });

  it("leaves the new-tab intent (cmd-click) to the browser", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: unknown[] = [];
    bus.on("projects:opened", (p) => opened.push(p));

    renderInWorkspace(<ChatLink href="/projects/default/x.png">x</ChatLink>, { store, bus });
    fireEvent.click(screen.getByText("x"), { metaKey: true });

    expect(opened).toEqual([]);
    expect(store.get("followTargetPath")).toBeUndefined();
  });

  it("falls back to a plain react-router link for non-workspace links", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/settings">settings</ChatLink>, { store, bus });
    const link = screen.getByText("settings") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(link.getAttribute("href")).toBe("/settings");
    expect(store.get("followTargetPath")).toBeUndefined();
    expect(autoPlaceApp).not.toHaveBeenCalled();
  });

  it("degrades to a default link when rendered outside the workspace", () => {
    // No WorkspaceStoreContext provider — must not throw, and a /projects link
    // becomes a plain react-router navigation.
    render(
      <MemoryRouter>
        <ChatLink href="/projects/default/x.png">x</ChatLink>
      </MemoryRouter>,
    );
    const link = screen.getByText("x") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/projects/default/x.png");
  });
});
