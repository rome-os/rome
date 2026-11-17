// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ChatOutputDto } from "@rome/api-types/chat-outputs";
import { chatTasksTopicName } from "@rome/api-types/live-events";
import { TASK_LIST_CHANGED_EVENT } from "@rome/api-types/task-list";
import i18n from "@/i18n";
import { LiveEventsClientContext } from "@/hooks/use-live-events";
import { acceptLatestSocket, fakeSocketLiveEventsClient } from "@/test/fake-websocket";
import { ThemeProvider } from "@/hooks/use-theme";
import { OutputsPanel, outputTitle, outputTypeOf, previewOf, readPrefix } from "./OutputsPanel";
import { outputOfLink } from "./chat-outputs";

const HOUR = 3_600_000;
let outputs: ChatOutputDto[];
let files: Record<string, string>;
let indexing: boolean;

function output(id: string, extra: Partial<ChatOutputDto>): ChatOutputDto {
  return {
    id,
    kind: "written",
    name: `${id}.txt`,
    path: `/projects/demo/${id}.txt`,
    link: `/projects/demo/${id}.txt`,
    mimeType: "text/plain",
    at: new Date(Date.now() - HOUR).toISOString(),
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

function renderPanel(props: { selectedId?: string; taskChats?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
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

  it("previews Markdown rendered, with no HTML running, and goes back to the list", async () => {
    const user = userEvent.setup();
    outputs = [output("notes", { name: "notes.md", mimeType: "text/markdown" })];
    files[outputs[0].contentUrl!] = "# Plan\n\n<img src=x onerror=alert(1)>\n\n- one";
    renderPanel({ selectedId: "notes" });
    const markdown = await screen.findByTestId("output-markdown");
    await waitFor(() =>
      expect(within(markdown).getByRole("heading", { name: "Plan" })).toBeTruthy(),
    );
    expect(markdown.querySelector("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back to outputs" }));
    expect(screen.getByRole("list", { name: "Today" })).toBeTruthy();
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
