// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ChatOutputDto } from "@rome/api-types/chat-outputs";
import i18n from "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { OutputsPanel, previewOf } from "./OutputsPanel";
import { outputOfLink } from "./chat-outputs";

const HOUR = 3_600_000;
let outputs: ChatOutputDto[];
let files: Record<string, string>;

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
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/chat/sessions/chat-1/outputs") {
        return new Response(JSON.stringify({ outputs }), {
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

function renderPanel(props: { selectedId?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <OutputsPanel chatId="chat-1" {...props} />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("OutputsPanel", () => {
  it("lists each output with its kind and time, and a task chat's with its chip", async () => {
    outputs = [
      output("notes", { name: "notes.md", mimeType: "text/markdown" }),
      output("chart", {
        kind: "shown",
        name: "chart.png",
        mimeType: "image/png",
        from: { chatId: "task-1", name: "Draft the report" },
      }),
    ];
    renderPanel();
    const list = await screen.findByRole("list", { name: "Files the agent produced" });
    const rows = within(list).getAllByRole("listitem");
    expect(
      rows.map((row) => row.querySelector("[data-slot='list-row-title']")?.textContent),
    ).toEqual(["notes.md", "chart.png"]);
    expect(rows[0].textContent).toContain("Written · 1 hr ago");
    expect(rows[1].textContent).toContain("Shown");
    const chip = within(rows[1]).getByRole("link", { name: "from Draft the report" });
    expect(chip.getAttribute("href")).toBe("/chat/task-1");
    expect(screen.getByText("Choose a file to preview it.")).toBeTruthy();
  });

  it("says a file that moved or went is gone, and offers nothing to open", async () => {
    outputs = [output("gone", { missing: true, contentUrl: null })];
    renderPanel({ selectedId: "gone" });
    const row = await screen.findByRole("button", { name: /gone\.txt/ });
    expect(row.textContent).toContain("Moved or deleted");
    // The preview says it too, with nothing to download.
    expect(screen.getByText("Moved or deleted")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
  });

  it("previews Markdown rendered, with no HTML running", async () => {
    outputs = [output("notes", { name: "notes.md", mimeType: "text/markdown" })];
    files[outputs[0].contentUrl!] = "# Plan\n\n<img src=x onerror=alert(1)>\n\n- one";
    renderPanel({ selectedId: "notes" });
    const markdown = await screen.findByTestId("output-markdown");
    await waitFor(() =>
      expect(within(markdown).getByRole("heading", { name: "Plan" })).toBeTruthy(),
    );
    expect(markdown.querySelector("img")).toBeNull();
  });

  it("previews plain text as text, a picture inline, and anything else as a download", async () => {
    const user = userEvent.setup();
    outputs = [
      output("log", { name: "run.log", mimeType: "text/plain" }),
      output("pic", { name: "pic.png", mimeType: "image/png", kind: "shown" }),
      output("zip", { name: "bundle.zip", mimeType: "application/zip" }),
    ];
    files[outputs[0].contentUrl!] = "line one\nline two";
    renderPanel({ selectedId: "log" });
    expect(await screen.findByText(/line one/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /pic\.png/ }));
    expect(screen.getByRole("img", { name: "pic.png" }).getAttribute("src")).toBe(
      outputs[1].contentUrl,
    );

    await user.click(screen.getByRole("button", { name: /bundle\.zip/ }));
    expect(screen.getByText("This file has no preview.")).toBeTruthy();
    const download = screen.getByRole("link", { name: "Download" });
    expect(download.getAttribute("href")).toBe(outputs[2].contentUrl);
    expect(download.getAttribute("download")).toBe("bundle.zip");
  });

  it("says so when the chat has no outputs", async () => {
    renderPanel();
    expect(await screen.findByText("No outputs yet")).toBeTruthy();
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
