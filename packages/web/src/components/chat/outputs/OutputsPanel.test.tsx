// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { OutputsPanel, outputTitle, outputTypeOf, previewOf, readPrefix } from "./OutputsPanel";
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
    path: `/projects/demo/${id}.txt`,
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
    expect((await screen.findByRole("heading", { name: /Outputs/ })).textContent).toContain("3");
    const today = screen.getByRole("list", { name: "Today" });
    const rows = within(today).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("button").textContent)).toEqual([
      "Trip notes",
      "Trip budget",
    ]);
    expect(rows[0].textContent).toContain("Document·Written");
    const chip = within(rows[1]).getByRole("link", { name: "from Draft the report" });
    expect(chip.getAttribute("href")).toBe("/chat/task-1");
    const earlier = screen.getByRole("list", { name: "Earlier" });
    expect(earlier.textContent).toContain("Page·Written");
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

  it("filters by documents, spreadsheets and pages, and keeps other kinds under All", async () => {
    const user = userEvent.setup();
    outputs = [
      output("notes", { name: "notes.md", mimeType: "text/markdown" }),
      output("sheet", { name: "sheet.xlsx", mimeType: null }),
      output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
    ];
    renderPanel();
    await screen.findByRole("list", { name: "Today" });
    await user.click(screen.getByRole("radio", { name: "Spreadsheets" }));
    expect(screen.getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("Sheet"),
    ]);
    await user.click(screen.getByRole("radio", { name: "Pages" }));
    expect(screen.getByText("No outputs of this kind yet.")).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
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
    const markdown = await screen.findByTestId("output-markdown");
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

      const markdown = await screen.findByTestId("output-markdown");
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
    await user.click(await screen.findByRole("button", { name: "Run" }));
    expect(await screen.findByText(/line one/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));

    await user.click(screen.getByRole("button", { name: "Pic" }));
    expect(screen.getByRole("img", { name: "pic.png" }).getAttribute("src")).toBe(
      outputs[1].contentUrl,
    );
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));

    await user.click(screen.getByRole("button", { name: "Bundle" }));
    expect(screen.getByText("This file has no preview.")).toBeTruthy();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(outputs[2].contentUrl);
    expect(download.getAttribute("download")).toBe("bundle.zip");
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
    expect(await screen.findByRole("button", { name: "Report" })).toBeTruthy();
  });

  it("says so when the chat has no outputs", async () => {
    renderPanel();
    expect(await screen.findByText("No outputs yet")).toBeTruthy();
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
  it("sorts files into the filters' kinds and names them without the extension", () => {
    expect(outputTypeOf({ name: "a.pdf", mimeType: "application/pdf" })).toBe("document");
    expect(outputTypeOf({ name: "a.tsv", mimeType: null })).toBe("spreadsheet");
    expect(outputTypeOf({ name: "a.html", mimeType: "text/html" })).toBe("page");
    expect(outputTypeOf({ name: "a.png", mimeType: "image/png" })).toBe("image");
    expect(outputTypeOf({ name: "a.ts", mimeType: null })).toBe("code");
    expect(outputTitle("weekly-news_digest.md")).toBe("Weekly news digest");
    expect(outputTitle("Rome 发布摘要.md")).toBe("Rome 发布摘要");
  });
});

describe("previewOf", () => {
  it("never previews a page that could run", () => {
    expect(previewOf({ name: "a.html", mimeType: "text/html" })).toBe("file");
    expect(previewOf({ name: "a.svg", mimeType: "image/svg+xml" })).toBe("file");
    expect(previewOf({ name: "a.json", mimeType: "application/json" })).toBe("text");
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
