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
  rs.unstubAllGlobals();
});

// isInternalHref reads window.location.{origin,href}; pin them so "same origin"
// is deterministic regardless of the jsdom default URL.
function stubOrigin(origin: string) {
  rs.stubGlobal("location", { ...window.location, origin, href: `${origin}/chat` });
}

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

  it("opens the linked file from an absolute same-origin projects URL", () => {
    // The deep link points at the instance the user is already on
    // (staging.romeos.cc), so it opens in-workspace rather than a new tab.
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="https://staging.romeos.cc/projects/conductor/docs/ui.md">UI docs</ChatLink>,
      { store, bus },
    );
    fireEvent.click(screen.getByText("UI docs"));

    expect(opened).toEqual([{ paths: ["/projects/conductor/docs/ui.md"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/conductor/docs/ui.md");
  });

  it("opens the file for a same-origin absolute URL on any host, not just *.romeos.cc", () => {
    // The internal test is origin-based, so a self-hosted instance on its own
    // domain follows its links in-workspace exactly like a cloud instance.
    stubOrigin("https://rome.example.org");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="https://rome.example.org/projects/conductor/docs/ui.md">docs</ChatLink>,
      { store, bus },
    );
    fireEvent.click(screen.getByText("docs"));

    expect(opened).toEqual([{ paths: ["/projects/conductor/docs/ui.md"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/conductor/docs/ui.md");
  });

  it("strips query and hash from the followed file path but keeps them on the anchor", () => {
    // The follow value locates a file, so ?query/#hash must not leak into it
    // (/resolve would treat `ui.md?foo=bar` as a missing filename). The anchor
    // keeps the full URL so Cmd/middle-click still opens the exact link.
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="https://staging.romeos.cc/projects/conductor/docs/ui.md?foo=bar#L10">
        docs
      </ChatLink>,
      { store, bus },
    );
    const link = screen.getByText("docs") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(opened).toEqual([{ paths: ["/projects/conductor/docs/ui.md"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/conductor/docs/ui.md");
    // The affordance still carries the full URL for new-tab / full-page open.
    expect(link.getAttribute("href")).toBe(
      "https://staging.romeos.cc/projects/conductor/docs/ui.md?foo=bar#L10",
    );
  });

  it("keeps an encoded %3F/%23 as filename content, cutting only a literal ?/#", () => {
    // The cut is on the raw string, so a percent-encoded question mark or hash
    // in the filename survives; only the first literal delimiter is dropped.
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="https://staging.romeos.cc/projects/default/faq%3F.md?tab=1">faq</ChatLink>,
      { store, bus },
    );
    fireEvent.click(screen.getByText("faq"));

    expect(opened).toEqual([{ paths: ["/projects/default/faq?.md"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/default/faq?.md");
  });

  it("does not follow a projects link to a different *.romeos.cc tenant", () => {
    // Separate Rome instances live at https://<slug>.romeos.cc; a link to
    // another tenant must stay external, never hijacked into this workspace.
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: unknown[] = [];
    bus.on("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="https://other-tenant.romeos.cc/projects/conductor/docs/ui.md">
        other tenant
      </ChatLink>,
      { store, bus },
    );
    const link = screen.getByText("other tenant") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(opened).toEqual([]);
    expect(link.target).toBe("_blank");
    expect(store.get("followTargetPath")).toBeUndefined();
  });

  it("leaves an absolute projects-shaped URL on another host external", () => {
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(
      <ChatLink href="https://example.com/projects/conductor/docs/ui.md">external docs</ChatLink>,
      { store, bus },
    );
    const link = screen.getByText("external docs") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(link.target).toBe("_blank");
    expect(store.get("followTargetPath")).toBeUndefined();
  });

  it("leaves a non-projects URL on the Rome Cloud control plane external", () => {
    // romeos.cc (the control plane) is a different origin than this instance's
    // <slug>.romeos.cc, so it is never treated as internal.
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="https://romeos.cc/blog">blog</ChatLink>, { store, bus });
    const link = screen.getByText("blog") as HTMLAnchorElement;
    fireEvent.click(link);

    expect(link.target).toBe("_blank");
    expect(store.get("followTargetPath")).toBeUndefined();
  });

  it("guards traversal on the raw absolute path before URL canonicalization", () => {
    // new URL() collapses `%2E%2E` dot-segments before any guard runs, so the
    // raw path must be validated directly. A relative href with the same
    // segments is rejected and followed verbatim; the absolute form must match
    // it, never synthesizing a canonicalized (e.g. traversed-out) target.
    stubOrigin("https://staging.romeos.cc");
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();
    const opened: Array<{ paths: string[]; force?: boolean }> = [];
    bus.on<{ paths: string[]; force?: boolean }>("projects:opened", (p) => opened.push(p));

    renderInWorkspace(
      <ChatLink href="https://staging.romeos.cc/projects/a/%2E%2E/%2E%2E/secret.txt">
        traversal
      </ChatLink>,
      { store, bus },
    );
    fireEvent.click(screen.getByText("traversal"));

    // The %2E%2E segments are preserved verbatim (not collapsed to /secret.txt
    // or /projects/secret.txt), exactly as the relative branch would leave them.
    expect(opened).toEqual([{ paths: ["/projects/a/%2E%2E/%2E%2E/secret.txt"], force: true }]);
    expect(store.get("followTargetPath")).toBe("/projects/a/%2E%2E/%2E%2E/secret.txt");
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

    expect(autoPlaceApp).toHaveBeenCalledWith("calendar", undefined, undefined, true);
  });

  it("preserves the in-app sub-route for a deep /apps link", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/apps/calendar/week/2024-06">cal</ChatLink>, { store, bus });
    fireEvent.click(screen.getByText("cal"));

    expect(autoPlaceApp).toHaveBeenCalledWith("calendar", "week/2024-06", undefined, true);
  });

  it("preserves query params for an /apps link", () => {
    const store = createWorkspaceStore();
    const bus = createWorkspaceEventBus();

    renderInWorkspace(<ChatLink href="/apps/connector?connector=gmail&status=ok">go</ChatLink>, {
      store,
      bus,
    });
    fireEvent.click(screen.getByText("go"));

    expect(autoPlaceApp).toHaveBeenCalledWith(
      "connector",
      undefined,
      {
        connector: "gmail",
        status: "ok",
      },
      true,
    );
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
