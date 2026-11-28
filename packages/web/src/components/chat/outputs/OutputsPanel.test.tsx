// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { MemoryRouter } from "react-router-dom";
import type { ChatOutputDto } from "@rome/api-types/chat-outputs";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import { TASK_LIST_CHANGED_EVENT } from "@rome/api-types/task-list";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { ThemeProvider } from "@/hooks/use-theme";
import { LARGE_TEXT_FILE_BYTES, getProjectsAutoSavePolicy } from "@/lib/projects-autosave";
import {
  type FilterRowSize,
  kindsThatFit,
  kindsThatStillFit,
  OutputsPanel,
  outputTitle,
  pageHrefOf,
  outputTypeOf,
  fileKindOf,
  readPrefix,
} from "./OutputsPanel";
import { outputOfLink } from "./chat-outputs";
import { projectPathOf } from "./OutputEditor";

// The editor is the Projects page's own browser; here it shows what it was
// asked to select and how, saves by itself or not, and holds the panel's exits
// until `canLeave` says they may go on.
const browser = { canLeave: true, mounts: 0, guardCalls: 0 };
rs.mock("@/components/file-browser-page", () => ({
  FileBrowserPage: ({
    apiBasePath,
    externalSelection,
    autoSave,
    leaveGuard,
    singleFile,
    embedded,
    logicalRootPath,
  }: {
    apiBasePath: string;
    externalSelection: { path: string; type: string } | null;
    autoSave?: unknown;
    leaveGuard?: { current: (() => Promise<boolean>) | null };
    singleFile?: boolean;
    embedded?: boolean;
    logicalRootPath: string;
  }) => {
    // Mounts, not renders: a remount is what would drop the editor.
    useEffect(() => {
      browser.mounts += 1;
    }, []);
    // As the real browser does: filled while it is mounted, empty after.
    useEffect(() => {
      if (!leaveGuard) return;
      leaveGuard.current = async () => {
        browser.guardCalls += 1;
        return browser.canLeave;
      };
      return () => {
        leaveGuard.current = null;
      };
    }, [leaveGuard]);
    return (
      <div
        data-testid="project-browser"
        data-api={apiBasePath}
        data-root={logicalRootPath}
        data-type={externalSelection?.type}
        data-autosave={autoSave === getProjectsAutoSavePolicy ? "projects" : "other"}
        data-single={singleFile ? "yes" : "no"}
        data-embedded={embedded ? "yes" : "no"}
      >
        {externalSelection?.path}
      </div>
    );
  },
}));

const HOUR = 3_600_000;
/** A moment earlier today, whatever the time the suite runs at: halfway since midnight. */
function earlierToday(): string {
  const now = Date.now();
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  return new Date(midnight + (now - midnight) / 2).toISOString();
}
let outputs: ChatOutputDto[];
let files: Record<string, string>;
let indexing: boolean;
/** What `/api/projects/resolve` answers for a logical path; anything else is missing. */
let resolved: Record<string, { editable?: boolean; size?: number; kind?: string }>;

function output(id: string, extra: Partial<ChatOutputDto>): ChatOutputDto {
  return {
    id,
    kind: "written",
    name: `${id}.txt`,
    path: `/projects/demo/${extra.name ?? `${id}.txt`}`,
    link: `/projects/demo/${id}.txt`,
    mimeType: "text/plain",
    at: earlierToday(),
    turnId: null,
    messageId: null,
    missing: false,
    from: null,
    contentUrl: `/api/chat/sessions/chat-1/outputs/${id}/content`,
    ...extra,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  files = {};
  outputs = [];
  indexing = false;
  resolved = {};
  browser.canLeave = true;
  browser.mounts = 0;
  browser.guardCalls = 0;
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions/chat-1/outputs") {
        return new Response(JSON.stringify({ outputs, indexing }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.startsWith("/api/projects/resolve?path=")) {
        const path = decodeURIComponent(url.slice("/api/projects/resolve?path=".length));
        const found = resolved[path];
        return new Response(
          JSON.stringify(
            found
              ? {
                  type: "file",
                  path,
                  kind: "text",
                  mimeType: "text/plain",
                  editable: true,
                  size: 5,
                  assetUrl: null,
                  ...found,
                }
              : { type: "missing", path },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = files[url];
      return body === undefined
        ? new Response("missing", { status: 404 })
        : new Response(body, { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function renderPanel(
  props: {
    selectedId?: string;
    taskChats?: boolean;
    onOpenTaskChat?: (id: string) => void;
    onNavigate?: () => void;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
        <ThemeProvider>
          <MemoryRouter>
            <OutputsPanel chatId="chat-1" {...props} />
          </MemoryRouter>
        </ThemeProvider>
      </LiveEventsClientContext.Provider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { client });
}

describe("OutputsPanel", () => {
  it("lists outputs as cards under Today and Earlier, with their total, type and source", async () => {
    outputs = [
      output("notes", { name: "trip-notes.md", mimeType: "text/markdown" }),
      output("budget", {
        name: "trip_budget.csv",
        mimeType: "text/csv",
        from: { chatId: "task-1", name: "Draft the report" },
      }),
      output("old", {
        name: "old-page.html",
        mimeType: "text/html",
        at: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
      }),
    ];
    renderPanel();
    const today = await screen.findByRole("list", { name: "Today" });
    // The tab or the sheet around the list names it: it has no heading of its own.
    expect(screen.queryByRole("heading", { name: /Outputs/ })).toBeNull();
    const rows = within(today).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("button").textContent)).toEqual([
      "Trip notes.md",
      "Trip budget.csv",
    ]);
    expect(rows[0].textContent).toContain("Document·Written");
    const chip = within(rows[1]).getByRole("link", { name: "from Draft the report" });
    expect(chip.getAttribute("href")).toBe("/chat/task-1");
    const earlier = screen.getByRole("list", { name: "Earlier" });
    expect(earlier.textContent).toContain("Page·Written");
  });

  it("aligns Today, Earlier, and indexing status to the 12px row inset in muted aux type", async () => {
    indexing = true;
    outputs = [
      output("notes", { name: "trip-notes.md", mimeType: "text/markdown" }),
      output("old", {
        name: "old-page.html",
        mimeType: "text/html",
        at: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
      }),
    ];
    renderPanel();
    await screen.findByRole("list", { name: "Today" });
    for (const label of ["Today", "Earlier"]) {
      const heading = screen.getByRole("heading", { level: 3, name: label });
      expect(heading.className).toContain("px-3");
      expect(heading.className).toContain("text-aux");
      expect(heading.className).toContain("text-muted-foreground");
      expect(heading.className).not.toContain("px-1");
      expect(heading.className).not.toContain("font-medium");
    }
    const status = screen.getByRole("status");
    expect(status.className).toContain("px-3");
    expect(status.className).not.toContain("px-1");
  });

  it("opens the task chat an output came from beside the chat where the host can", async () => {
    outputs = [
      output("budget", {
        name: "budget.csv",
        from: { chatId: "task-1", name: "Draft the report" },
      }),
    ];
    const onOpenTaskChat = rs.fn();
    const onNavigate = rs.fn();
    renderPanel({ onOpenTaskChat, onNavigate });
    const chip = await screen.findByRole("link", { name: "from Draft the report" });
    expect(chip.getAttribute("href")).toBe("/chat/task-1");
    fireEvent.click(chip);
    expect(onOpenTaskChat).toHaveBeenCalledWith("task-1", "Draft the report");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("offers All and each kind the chat holds, the most held first", async () => {
    const user = userEvent.setup();
    outputs = [
      output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
      output("map", { name: "map.png", mimeType: "image/png", kind: "shown" }),
      output("sheet", { name: "sheet.xlsx", mimeType: null }),
      output("notes", { name: "notes.md", mimeType: "text/markdown" }),
    ];
    renderPanel();
    await screen.findByRole("list", { name: "Today" });
    // Pictures lead with two; the kinds held once keep their usual order.
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent)).toEqual([
      "All",
      "Pictures",
      "Documents",
      "Spreadsheets",
    ]);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Spreadsheets" }));
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Sheet.xlsx"),
    ]);
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
  });

  it("puts the kinds past three under More, which names the one it filters by", async () => {
    const user = userEvent.setup();
    outputs = [
      output("notes", { name: "notes.md", mimeType: "text/markdown" }),
      output("plan", { name: "plan.md", mimeType: "text/markdown" }),
      output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
      output("sheet", { name: "sheet.csv", mimeType: "text/csv" }),
      output("site", { name: "site.html", mimeType: "text/html" }),
      output("voice", { name: "voice.wav", mimeType: "audio/wav" }),
      output("script", { name: "script.ts", mimeType: "text/typescript" }),
    ];
    renderPanel();
    await screen.findByRole("list", { name: "Today" });
    expect(screen.getAllByRole("radio").map((chip) => chip.textContent)).toEqual([
      "All",
      "Documents",
      "Pictures",
      "Spreadsheets",
    ]);
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
      "Pages",
      "Audio",
      "Code",
    ]);
    await user.click(screen.getByRole("menuitemradio", { name: "Audio" }));
    const more = screen.getByRole("button", { name: "More: Audio" });
    expect(more.textContent).toBe("Audio");
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Voice.wav"),
    ]);
    expect(
      screen.getAllByRole("radio").some((chip) => chip.getAttribute("aria-checked") === "true"),
    ).toBe(false);
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(7);
  });

  it("shows as many kinds as the row's width holds, and lays them out again as it resizes", async () => {
    // Every chip is 8px a letter plus its padding, side by side with no gap.
    const original = Element.prototype.getBoundingClientRect;
    const OriginalObserver = globalThis.ResizeObserver;
    const resized: (() => void)[] = [];
    let rowWidth = 260;
    const widthOf = (element: Element) => (element.textContent?.length ?? 0) * 8 + 24;
    const box = (left: number, width: number) =>
      ({
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 0,
        height: 0,
        x: left,
        y: 0,
      }) as DOMRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute("data-slot") === "output-filters") return box(0, rowWidth);
      const measure = this.closest('[data-slot="output-filters-measure"]');
      if (!measure) return original.call(this);
      if (!this.matches("[data-slot=filter-chip]")) return box(0, widthOf(this) + 16);
      let left = 0;
      for (const chip of measure.querySelectorAll("[data-slot=filter-chip]")) {
        if (chip === this) break;
        left += widthOf(chip);
      }
      return box(left, widthOf(this));
    };
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        resized.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const user = userEvent.setup();
      outputs = [
        output("notes", { name: "notes.md", mimeType: "text/markdown" }),
        output("plan", { name: "plan.md", mimeType: "text/markdown" }),
        output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
        output("sheet", { name: "sheet.csv", mimeType: "text/csv" }),
        output("site", { name: "site.html", mimeType: "text/html" }),
        output("voice", { name: "voice.wav", mimeType: "audio/wav" }),
        output("script", { name: "script.ts", mimeType: "text/typescript" }),
      ];
      renderPanel();
      await screen.findByRole("list", { name: "Today" });
      const chips = () => screen.getAllByRole("radio").map((chip) => chip.textContent);
      // 260px holds All (48), Documents (96) and More (72), not Pictures too.
      await waitFor(() => expect(chips()).toEqual(["All", "Documents"]));
      const resize = (width: number) => {
        rowWidth = width;
        act(() => {
          for (const callback of resized) callback();
        });
      };
      // 310px fits Pictures beside More (304) but not with the 12px to spare.
      resize(310);
      expect(chips()).toEqual(["All", "Documents"]);
      // Choosing a filter does not bring it in either; only room to spare does.
      await user.click(screen.getByRole("radio", { name: "Documents" }));
      expect(chips()).toEqual(["All", "Documents"]);
      resize(330);
      expect(chips()).toEqual(["All", "Documents", "Pictures"]);
      await user.click(screen.getByRole("button", { name: "More" }));
      expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([
        "Spreadsheets",
        "Pages",
        "Audio",
        "Code",
      ]);
      await user.click(screen.getByRole("menuitemradio", { name: "Audio" }));
      expect(screen.getByRole("button", { name: "More: Audio" }).textContent).toBe("Audio");
      expect(chips()).toEqual(["All", "Documents", "Pictures"]);
    } finally {
      Element.prototype.getBoundingClientRect = original;
      globalThis.ResizeObserver = OriginalObserver;
    }
  });

  it("offers no filters while the chat holds one kind", async () => {
    outputs = [
      output("notes", { name: "notes.md", mimeType: "text/markdown" }),
      output("plan", { name: "plan.txt" }),
    ];
    renderPanel();
    await screen.findByRole("list", { name: "Today" });
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("says a file that moved or went is gone, and offers nothing to open", async () => {
    outputs = [output("gone", { missing: true, contentUrl: null })];
    renderPanel({ selectedId: "gone" });
    expect((await screen.findAllByText("Moved or deleted")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  });

  it("previews ordinary Markdown with links and images, sanitizes HTML, and goes back to the list", async () => {
    const user = userEvent.setup();
    outputs = [output("notes", { name: "notes.md", mimeType: "text/markdown" })];
    files[outputs[0].contentUrl!] =
      "# Plan\n\n[Reference](https://example.com/reference)\n\n![Chart](https://example.com/chart.png)\n\n<img src=x onerror=alert(1)>\n\n- one";
    renderPanel({ selectedId: "notes" });
    const markdown = await screen.findByTestId("output-preview");
    await waitFor(() =>
      expect(within(markdown).getByRole("heading", { name: "Plan" })).toBeTruthy(),
    );
    expect(within(markdown).getByRole("link", { name: "Reference" }).getAttribute("href")).toBe(
      "https://example.com/reference",
    );
    expect(within(markdown).getByRole("img", { name: "Chart" }).getAttribute("src")).toBe(
      "https://example.com/chart.png",
    );
    expect(markdown.querySelector("[onerror]")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    expect(screen.getByRole("list", { name: "Today" })).toBeTruthy();
  });

  it("renders a Mermaid flowchart in a Markdown output preview", async () => {
    const measureText = rs.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    rs.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(private readonly callback: IntersectionObserverCallback) {}
        observe(target: Element) {
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );
    try {
      outputs = [output("report", { name: "report.md", mimeType: "text/markdown" })];
      files[outputs[0].contentUrl!] =
        "# Architecture\n\n```mermaid\nflowchart TD\n    W[Web React / Vite] --> RPC[认证 WebSocket RPC + HTTP]\n```";
      renderPanel({ selectedId: "report" });

      const markdown = await screen.findByTestId("output-preview");
      await waitFor(() => expect(markdown.querySelector("svg.pele-flowchart")).not.toBeNull());
      expect(markdown.querySelector("svg.pele-flowchart")?.textContent).toContain(
        "Web React / Vite",
      );
      expect(markdown.querySelector('[data-streamdown="code-block"]')).toBeNull();
    } finally {
      measureText.mockRestore();
    }
  });

  it("opens a row's preview: text as text, a picture inline, anything else as a download", async () => {
    const user = userEvent.setup();
    outputs = [
      output("log", { name: "run.log", mimeType: "text/plain" }),
      output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
      output("zip", { name: "bundle.zip", mimeType: "application/zip" }),
    ];
    files[outputs[0].contentUrl!] = "line one\nline two";
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Run.log" }));
    expect(await screen.findByText(/line one/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));

    await user.click(screen.getByRole("button", { name: "Pic.png" }));
    expect(screen.getByRole("img", { name: "pic.png" }).getAttribute("src")).toBe(
      outputs[1].contentUrl,
    );
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));

    await user.click(screen.getByRole("button", { name: "Bundle.zip" }));
    expect(screen.getByText("This file has no preview.")).toBeTruthy();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(outputs[2].contentUrl);
    expect(download.getAttribute("download")).toBe("bundle.zip");
  });

  it("draws a page with nothing in it running, and opens it in a new tab to run", async () => {
    const user = userEvent.setup();
    outputs = [
      output("map", {
        name: "trip-map.html",
        mimeType: "text/html",
        link: "/projects/demo/trip-map.html",
      }),
      output("copy", {
        name: "copy.html",
        mimeType: "text/html",
        kind: "shown",
        link: "/api/assets/0f3c2a9d7b1e4c6a8d5f2b7e9a1c3d4e.html",
        links: ["/api/assets/0f3c2a9d7b1e4c6a8d5f2b7e9a1c3d4e.html"],
      }),
    ];
    files[outputs[0].contentUrl!] = "<h1>Trip</h1><script>alert(1)</script>";
    files[outputs[1].contentUrl!] = "<p>Copy</p>";
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Trip map.html" }));
    const frame = await screen.findByTitle("trip-map.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe("<h1>Trip</h1><script>alert(1)</script>");
    expect(frame.getAttribute("src")).toBeNull();
    const open = screen.getByRole("link", { name: "Open in new tab" });
    expect(open.getAttribute("href")).toBe("/projects/demo/trip-map.html");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toBe("noopener noreferrer");
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));

    // A copy of a file outside both folders only downloads, so it has nowhere to open.
    await user.click(screen.getByRole("button", { name: "Copy.html" }));
    expect((await screen.findByTitle("copy.html")).getAttribute("sandbox")).toBe("");
    expect(screen.queryByRole("link", { name: "Open in new tab" })).toBeNull();
  });

  it("previews video, audio, PDF and SVG as the projects viewer does", async () => {
    const user = userEvent.setup();
    outputs = [
      output("clip", { name: "clip.mp4", mimeType: "video/mp4", fileKind: "video" }),
      output("song", { name: "song.mp3", mimeType: "audio/mpeg", fileKind: "audio" }),
      output("paper", { name: "paper.pdf", mimeType: "application/pdf", fileKind: "pdf" }),
      // An older server names no kind: the MIME type says it.
      output("logo", { name: "logo.svg", mimeType: "image/svg+xml" }),
    ];
    const { container } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Clip.mp4" }));
    expect(container.querySelector("video source")?.getAttribute("src")).toBe(
      outputs[0].contentUrl,
    );
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    await user.click(screen.getByRole("button", { name: "Song.mp3" }));
    expect(container.querySelector("audio source")?.getAttribute("src")).toBe(
      outputs[1].contentUrl,
    );
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    await user.click(screen.getByRole("button", { name: "Paper.pdf" }));
    expect(container.querySelector("object")?.getAttribute("data")).toBe(outputs[2].contentUrl);
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    await user.click(screen.getByRole("button", { name: "Logo.svg" }));
    expect(screen.getByRole("img", { name: "logo.svg" }).getAttribute("src")).toBe(
      outputs[3].contentUrl,
    );
  });

  it("says quietly while earlier outputs are still being read back", async () => {
    indexing = true;
    renderPanel();
    expect(await screen.findByText("Still finding earlier files.")).toBeTruthy();
    expect(screen.queryByText("No outputs yet")).toBeNull();
  });

  it("reads again when a Concierge chat's task list changes, as a task chat's turn ends", async () => {
    outputs = [output("notes", { name: "notes.md", mimeType: "text/markdown" })];
    renderPanel({ taskChats: true });
    await screen.findByRole("list", { name: "Today" });
    outputs = [
      output("report", { name: "report.md", from: { chatId: "task-1", name: "Report" } }),
      ...outputs,
    ];
    acceptLatestSocket().receive({
      type: "event",
      topic: chatTasksTopicName("chat-1"),
      event: TASK_LIST_CHANGED_EVENT,
      data: { chatId: "chat-1" },
    });
    expect(await screen.findByRole("button", { name: "Report.md" })).toBeTruthy();
  });

  it("says so when the chat has no outputs", async () => {
    renderPanel();
    expect(await screen.findByText("No outputs yet")).toBeTruthy();
  });

  it("opens a file in the list's place under a header row: back, its full name and kind, Download", async () => {
    const user = userEvent.setup();
    outputs = [
      output("clip", { name: "sunset.mp4", mimeType: "video/mp4", kind: "shown" }),
      output("plan", { name: "Trip plan.md", mimeType: "text/markdown" }),
    ];
    files[outputs[1].contentUrl!] = "# Plan";
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sunset.mp4" }));
    // The list gives way to the file; its header names it with its extension.
    expect(screen.queryByRole("list", { name: "Today" })).toBeNull();
    expect(screen.getByText("Sunset.mp4")).toBeTruthy();
    expect(screen.getByText("Video")).toBeTruthy();
    expect(screen.getByText("Shown")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe(
      outputs[0].contentUrl,
    );
    expect(screen.getByRole("button", { name: "Back to outputs" })).toBeTruthy();
  });

  it("comes back from a file to the list as it was: its filter, its scroll and the file marked", async () => {
    const user = userEvent.setup();
    // jsdom lays nothing out, so each element keeps the scroll it is given.
    const scrolls = new WeakMap<Element, number>();
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get() {
        return scrolls.get(this) ?? 0;
      },
      set(value: number) {
        scrolls.set(this, value);
      },
    });
    try {
      outputs = [
        output("notes", { name: "notes.md", mimeType: "text/markdown" }),
        output("plan", { name: "plan.md", mimeType: "text/markdown" }),
        output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
      ];
      files[outputs[1].contentUrl!] = "# Plan";
      renderPanel();
      await screen.findByRole("list", { name: "Today" });
      await user.click(screen.getByRole("radio", { name: "Documents" }));
      const list = screen.getByTestId("chat-outputs");
      list.scrollTop = 240;
      fireEvent.scroll(list);

      await user.click(screen.getByRole("button", { name: "Plan.md" }));
      await user.click(await screen.findByRole("button", { name: "Back to outputs" }));

      const back = screen.getByTestId("chat-outputs");
      expect(back.scrollTop).toBe(240);
      expect(screen.getByRole("radio", { name: "Documents" }).getAttribute("aria-checked")).toBe(
        "true",
      );
      expect(screen.queryByRole("button", { name: "Pic.png" })).toBeNull();
      const row = screen.getByRole("button", { name: "Plan.md" });
      expect(document.activeElement).toBe(row);
      expect(row.closest("li")?.className).toContain("bg-surface-muted");
      expect(
        screen.getByRole("button", { name: "Notes.md" }).closest("li")?.className,
      ).not.toContain("bg-surface-muted");
    } finally {
      if (descriptor) Object.defineProperty(Element.prototype, "scrollTop", descriptor);
    }
  });
});

describe("editing an output in the projects folder", () => {
  const edit = () => screen.queryByRole("button", { name: "Edit" });

  /** Opens `output` after the projects folder has answered for `path`. */
  async function open(
    extra: Partial<ChatOutputDto>,
    answer: (typeof resolved)[string] | null = {},
    path = `projects/demo/${extra.name ?? "x.txt"}`,
    body = "hello",
  ) {
    const name = extra.name ?? "x.txt";
    outputs = [
      output("one", { path: `/projects/demo/${name}`, link: `/projects/demo/${name}`, ...extra }),
    ];
    files[outputs[0].contentUrl!] = body;
    if (answer) resolved[path] = answer;
    renderPanel({ selectedId: "one" });
  }

  it("offers Edit on a written text file, an empty one and a Markdown one", async () => {
    await open({ name: "notes.txt" });
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
    cleanup();

    await open({ name: "empty.txt" }, {}, "projects/demo/empty.txt", "");
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
    cleanup();

    await open({ name: "plan.md", mimeType: "text/markdown" });
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
    cleanup();

    await open({ name: "plan.md", mimeType: "text/markdown" }, { size: LARGE_TEXT_FILE_BYTES });
    expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("offers nothing to edit for any other output", async () => {
    const cases: [string, Partial<ChatOutputDto>, ((typeof resolved)[string] | null)?, string?][] =
      [
        [
          "a memory file",
          { name: "me.md", mimeType: "text/markdown", link: null, path: "/home/p/memory/me.md" },
        ],
        [
          "a shown copy",
          {
            name: "a.txt",
            kind: "shown",
            link: "/api/assets/abc.txt",
            path: "/api/assets/abc.txt",
          },
        ],
        ["a path outside the projects", { name: "a.txt", link: "/home/p/elsewhere/a.txt" }],
        ["a page", { name: "a.html", mimeType: "text/html" }],
        ["a picture", { name: "a.png", mimeType: "image/png" }],
        ["a PDF", { name: "a.pdf", mimeType: "application/pdf" }],
        ["a file that is gone", { name: "a.txt", missing: true, contentUrl: null }],
        ["a file the folder says is not editable", { name: "a.txt" }, { editable: false }],
        ["a file the folder has not got", { name: "a.txt" }, null],
        ["a binary file", { name: "a.txt" }, { kind: "binary" }],
        ["a file over 1 MB", { name: "big.txt" }, { size: LARGE_TEXT_FILE_BYTES + 1 }],
        // Text, but not what the Projects page saves by itself.
        ["a JSON file", { name: "a.json", mimeType: "application/json" }],
        ["a CSV file", { name: "a.csv", mimeType: "text/csv" }],
        ["a script", { name: "a.py", mimeType: "text/x-python" }],
        ["a YAML file", { name: "a.yaml", mimeType: "application/yaml" }],
        ["a path that climbs out", { name: "a.txt", link: "/projects/demo/../a.txt" }],
      ];
    for (const [label, extra, answer, path] of cases) {
      cleanup();
      await open(extra, answer, path);
      // The preview has settled and the folder has had its say.
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Back to outputs" })).toBeTruthy(),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(edit(), label).toBeNull();
    }
  });

  it("opens the Projects editor on the file's own path, Chinese name and all, and nothing else", async () => {
    const user = userEvent.setup();
    const name = "行程 计划 100%.txt";
    outputs = [
      output("one", { name, path: `/projects/旅行/${name}`, link: `/projects/旅行/${name}` }),
    ];
    files[outputs[0].contentUrl!] = "hello";
    resolved[`projects/旅行/${name}`] = {};
    renderPanel({ selectedId: "one" });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = await screen.findByTestId("project-browser");
    expect(editor.textContent).toBe(`projects/旅行/${name}`);
    expect(editor.dataset.api).toBe("/api/projects");
    expect(editor.dataset.root).toBe("projects");
    expect(editor.dataset.type).toBe("file");
    expect(editor.dataset.autosave).toBe("projects");
    expect(editor.dataset.single).toBe("yes");
    expect(editor.dataset.embedded).toBe("yes");
    // The preview is not drawn under it, and Edit has become Done.
    expect(screen.queryByText("hello")).toBeNull();
    expect(edit()).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("settles unsaved edits before Done or Back, and stays when it is told not to leave", async () => {
    const user = userEvent.setup();
    await open({ name: "notes.txt" });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByTestId("project-browser");

    browser.canLeave = false;
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    expect(screen.getByTestId("project-browser")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Today" })).toBeNull();

    browser.canLeave = true;
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    expect(await screen.findByRole("list", { name: "Today" })).toBeTruthy();
  });

  it("keeps the editor, and its edits, when the agent writes the same file again", async () => {
    const user = userEvent.setup();
    outputs = [output("one", { name: "notes.txt", link: "/projects/demo/notes.txt", from: null })];
    files[outputs[0].contentUrl!] = "hello";
    resolved["projects/demo/notes.txt"] = {};
    renderPanel({ selectedId: "one", taskChats: true });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByTestId("project-browser");
    const mounts = browser.mounts;

    // The same file again: a new record, so the old one's id is gone.
    browser.canLeave = false;
    outputs = [output("two", { name: "notes.txt", link: "/projects/demo/notes.txt" })];
    files[outputs[0].contentUrl!] = "hello again";
    acceptLatestSocket().receive({
      type: "event",
      topic: chatTasksTopicName("chat-1"),
      event: TASK_LIST_CHANGED_EVENT,
      data: { chatId: "chat-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByTestId("project-browser")).toBeTruthy();
    expect(browser.guardCalls).toBe(0);
    expect(browser.mounts).toBe(mounts);

    // Done lands on the new record's preview.
    browser.canLeave = true;
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("hello again")).toBeTruthy();
  });

  it("keeps the editor when the folder later says the file cannot be edited", async () => {
    const user = userEvent.setup();
    await open({ name: "notes.txt" });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByTestId("project-browser");

    resolved["projects/demo/notes.txt"] = { editable: false, size: LARGE_TEXT_FILE_BYTES + 1 };
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByTestId("project-browser")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    expect(browser.guardCalls).toBe(0);
  });

  it("shows the file as it was saved once Done returns to the preview", async () => {
    const user = userEvent.setup();
    await open({ name: "notes.txt" });
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByTestId("project-browser");
    files[outputs[0].contentUrl!] = "hello, edited";
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("hello, edited")).toBeTruthy();
    expect(screen.queryByTestId("project-browser")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("hands its host the guard, which is the editor's while one is open and none after", async () => {
    const user = userEvent.setup();
    const guard: { current: (() => Promise<boolean>) | null } = { current: null };
    outputs = [output("one", { name: "notes.txt", link: "/projects/demo/notes.txt" })];
    files[outputs[0].contentUrl!] = "hello";
    resolved["projects/demo/notes.txt"] = {};
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <LiveEventsClientContext.Provider value={fakeSocketLiveEventsClient()}>
          <ThemeProvider>
            <MemoryRouter>
              <OutputsPanel chatId="chat-1" selectedId="one" leaveGuard={guard} />
            </MemoryRouter>
          </ThemeProvider>
        </LiveEventsClientContext.Provider>
      </QueryClientProvider>,
    );
    expect(guard.current).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByTestId("project-browser");
    browser.canLeave = false;
    expect(await guard.current?.()).toBe(false);
    browser.canLeave = true;
    await user.click(screen.getByRole("button", { name: "Done" }));
    await screen.findByRole("button", { name: "Edit" });
    expect(guard.current).toBeNull();
  });
});

describe("projectPathOf", () => {
  it("names a project file by the path the file browser uses, and nothing outside the projects", () => {
    expect(projectPathOf({ link: "/projects/demo/a b.txt" })).toBe("projects/demo/a b.txt");
    expect(projectPathOf({ link: "/projects/旅行/100%.txt" })).toBe("projects/旅行/100%.txt");
    expect(projectPathOf({ link: "/projects/a%41.txt" })).toBe("projects/a%41.txt");
    expect(projectPathOf({ link: "/projects/" })).toBeNull();
    expect(projectPathOf({ link: "/projects/a/../b.txt" })).toBeNull();
    expect(projectPathOf({ link: "/projects/a//b.txt" })).toBeNull();
    expect(projectPathOf({ link: "/api/assets/a.txt" })).toBeNull();
    expect(projectPathOf({ link: "/memory/a.md" })).toBeNull();
    expect(projectPathOf({ link: null })).toBeNull();
  });
});

describe("outputTypeOf and outputTitle", () => {
  it("sorts files into the filters' kinds and names them with their extension", () => {
    expect(outputTypeOf({ name: "a.pdf", path: "a.pdf", mimeType: "application/pdf" })).toBe(
      "document",
    );
    expect(outputTypeOf({ name: "a.tsv", path: "a.tsv", mimeType: null })).toBe("spreadsheet");
    expect(outputTypeOf({ name: "a.html", path: "a.html", mimeType: "text/html" })).toBe("page");
    expect(outputTypeOf({ name: "a.png", path: "a.png", mimeType: "image/png" })).toBe("image");
    expect(outputTypeOf({ name: "a.ts", path: "a.ts", mimeType: null })).toBe("code");
    expect(outputTypeOf({ name: "a.pptx", path: "a.pptx", mimeType: null })).toBe("document");
    expect(outputTypeOf({ name: "a.wav", path: "a.wav", mimeType: "audio/wav" })).toBe("audio");
    expect(outputTypeOf({ name: "a.mp4", path: "a.mp4", mimeType: "video/mp4" })).toBe("video");
    expect(outputTypeOf({ name: "a.diff", path: "a.diff", mimeType: null })).toBe("code");
    expect(outputTypeOf({ name: "a.zip", path: "a.zip", mimeType: "application/zip" })).toBe(
      "file",
    );
    expect(outputTitle("weekly-news_digest.md")).toBe("Weekly news digest.md");
    expect(outputTitle("sample.mp4")).toBe("Sample.mp4");
    expect(outputTitle("Rome 发布摘要.md")).toBe("Rome 发布摘要.md");
    expect(outputTitle("README")).toBe("README");
    expect(outputTitle(".env")).toBe(".env");
  });
});

describe("kindsThatFit", () => {
  // All ends at 50 and each of three kinds adds 100; More is 60 wide, or 100 naming a kind.
  const size = (width: number): FilterRowSize => ({
    width,
    gap: 8,
    ends: [50, 150, 250, 350],
    more: 60,
    moreNamed: [100, 100, 100],
  });

  it("shows as many kinds as fit beside All and More, and needs no More when all fit", () => {
    expect(kindsThatFit(size(100), -1)).toBe(0);
    expect(kindsThatFit(size(300), -1)).toBe(1);
    expect(kindsThatFit(size(330), -1)).toBe(2);
    expect(kindsThatFit(size(350), -1)).toBe(3);
  });

  it("leaves room for More to name the kind chosen under it", () => {
    expect(kindsThatFit(size(330), 2)).toBe(1);
    expect(kindsThatFit(size(330), 0)).toBe(2);
  });

  it("drops a chip as soon as it no longer fits, and shows one again only with room to spare", () => {
    expect(kindsThatStillFit(size(317), -1, 2)).toBe(1);
    expect(kindsThatStillFit(size(320), -1, 1)).toBe(1);
    expect(kindsThatStillFit(size(331), -1, 1)).toBe(2);
    expect(kindsThatStillFit(size(320), -1, 2)).toBe(2);
  });
});

describe("fileKindOf", () => {
  it("takes the server's kind, else the MIME type's, else the path's", () => {
    expect(fileKindOf({ path: "a.bin", mimeType: null, fileKind: "video" })).toBe("video");
    expect(fileKindOf({ path: "a", mimeType: "application/pdf" })).toBe("pdf");
    expect(fileKindOf({ path: "/api/assets/a.docx", mimeType: null })).toBe("docx");
    expect(fileKindOf({ path: "a.zip", mimeType: "application/zip" })).toBe("binary");
    expect(fileKindOf({ path: "/projects/demo/notes.markdown", mimeType: null })).toBe("text");
  });
});

describe("pageHrefOf", () => {
  const page = { name: "trip map.html", path: "trip map.html", mimeType: "text/html" };

  it("opens a written page in the projects folder on its own page", () => {
    expect(
      pageHrefOf({
        ...page,
        link: "/projects/demo/trip map.html",
        links: ["/home/rome/projects/demo/trip map.html", "/projects/demo/trip map.html"],
      }),
    ).toBe("/projects/demo/trip%20map.html");
  });

  it("opens a written page in the memory folder from its links, as the server gives it", () => {
    expect(
      pageHrefOf({
        ...page,
        link: null,
        links: ["/home/rome/memory/notes/trip map.html", "/memory/notes/trip map.html"],
      }),
    ).toBe("/memory/notes/trip%20map.html");
  });

  it("opens the file a shown copy was made from, when it is in either folder", () => {
    expect(
      pageHrefOf({
        ...page,
        link: "/api/assets/0f3c.html",
        links: [
          "/api/assets/0f3c.html",
          "/home/rome/projects/demo/trip map.html",
          "/projects/demo/trip map.html",
        ],
      }),
    ).toBe("/projects/demo/trip%20map.html");
  });

  it("leaves a copy with no such file, a page outside both folders and any other file alone", () => {
    expect(
      pageHrefOf({ ...page, link: "/api/assets/0f3c.html", links: ["/api/assets/0f3c.html"] }),
    ).toBeNull();
    expect(pageHrefOf({ ...page, link: null, links: ["/tmp/trip map.html"] })).toBeNull();
    expect(
      pageHrefOf({
        name: "bundle.zip",
        path: "bundle.zip",
        mimeType: "application/zip",
        link: "/projects/demo/bundle.zip",
      }),
    ).toBeNull();
  });
});

describe("outputOfLink", () => {
  it("matches a file link to its output and leaves folders and other files alone", () => {
    const list = [output("notes", {}), output("pic", { link: "/api/assets/abc.png" })];
    expect(outputOfLink(list, "/projects/demo/notes.txt")?.id).toBe("notes");
    expect(outputOfLink(list, "/api/assets/abc.png?x=1")?.id).toBe("pic");
    expect(outputOfLink(list, "/projects/demo")).toBeUndefined();
    expect(outputOfLink(list, "/projects/demo/other.txt")).toBeUndefined();
  });

  it("matches an earlier link to the same file, or its absolute path", () => {
    const list = [
      output("chart", {
        kind: "shown",
        link: "/api/assets/new.png",
        links: [
          "/api/assets/new.png",
          "/api/assets/old.png",
          "/projects/demo/chart.png",
          "/home/p/demo/chart.png",
        ],
      }),
    ];
    expect(outputOfLink(list, "/api/assets/old.png")?.id).toBe("chart");
    expect(outputOfLink(list, "/projects/demo/chart.png")?.id).toBe("chart");
    expect(outputOfLink(list, "/home/p/demo/chart.png")?.id).toBe("chart");
  });
});

describe("readPrefix", () => {
  it("reads only the first characters of a large file, then stops reading", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(1000));
    const cancel = rs.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });
    rs.stubGlobal(
      "fetch",
      rs.fn(async () => new Response(body, { status: 200 })),
    );
    const prefix = await readPrefix("/big.log", 2500);
    expect(prefix).toEqual({ text: "x".repeat(2500), cut: true });
    expect(pulled).toBeLessThan(10);
    expect(cancel).toHaveBeenCalled();
  });
});
