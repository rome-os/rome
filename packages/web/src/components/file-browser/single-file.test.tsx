// @rstest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { FileBrowserStoreProvider, useFileBrowserStoreApi } from "./store/context";
import { FileViewHeader } from "./FileView";
import { useDocumentLinkInterceptor } from "./hooks/useDocumentLinkInterceptor";
import i18n from "@/i18n";
import { ThemeProvider } from "@/hooks/use-theme";
import { FileBrowserPage } from "@/components/file-browser-page";

// The editor is a heavy lazy module with nothing to say here.
rs.mock("@/components/monaco-file-editor", () => ({
  MonacoFileEditor: () => <div data-testid="editor" />,
}));

const NOTES = "projects/demo/notes.md";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubApi() {
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/projects/tree") {
        return json([
          {
            name: "demo",
            path: "projects/demo",
            type: "directory",
            children: [{ name: "notes.md", path: NOTES, type: "file" }],
          },
        ]);
      }
      if (url.pathname === "/api/projects/file") {
        return json({
          assetUrl: null,
          content: "# Notes",
          editable: true,
          kind: "text",
          mimeType: "text/markdown",
          path: NOTES,
          size: 7,
        });
      }
      return new Response("{}", { status: 404 });
    }),
  );
}

function renderBrowser(singleFile: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter>
          <FileBrowserPage
            apiBasePath="/api/projects"
            embedded
            externalSelection={{ path: NOTES, type: "file" }}
            logicalRootPath="projects"
            rootLabel="Projects"
            searchPlaceholder="Search projects"
            singleFile={singleFile}
          />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("FileBrowserPage singleFile", () => {
  it("shows only the file: no tree, no file list, no way back to them", async () => {
    stubApi();
    renderBrowser(true);
    await screen.findByTestId("editor");
    expect(screen.queryByPlaceholderText("Search projects")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to files" })).toBeNull();
    expect(screen.queryByText("demo")).toBeNull();
    // The host names the file and offers its download; Save and History stay.
    expect(screen.queryByText("notes.md")).toBeNull();
    expect(screen.queryByText(/text\/markdown/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /history/i }).length).toBeGreaterThan(0);
  });

  it("opens a Markdown file in the editor, not the rendered preview", async () => {
    stubApi();
    renderBrowser(true);
    await screen.findByTestId("editor");
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Edit" }).getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("keeps the tree and the file list where nothing asks for one file", async () => {
    stubApi();
    renderBrowser(false);
    expect((await screen.findAllByPlaceholderText("Search projects")).length).toBeGreaterThan(0);
    expect(await screen.findByText("demo")).toBeTruthy();
    // The header names the file and path and offers its download, as ever.
    expect(screen.getAllByText("notes.md").length).toBeGreaterThan(0);
    expect(screen.getByText(/text\/markdown/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });
});

describe("FileViewHeader autosave status", () => {
  const file = {
    assetUrl: null,
    content: "a",
    editable: true,
    kind: "text" as const,
    mimeType: "text/plain",
    path: "projects/demo/a.txt",
    size: 1,
  };

  function renderHeader(singleFile: boolean) {
    const config = {
      apiBasePath: "/api/projects",
      logicalRootPath: "projects",
      rootLabel: "projects",
      initialSelectedFolderPath: null,
      queryClient: new QueryClient(),
      navigate: rs.fn(),
      getRouteSnapshot: () => ({ pathname: "/", search: "", hash: "" }),
      t: i18n.getFixedT("en", "files"),
      embedded: true,
      autoSave: () => ({ delayMs: 2000 }),
    };
    function Seed() {
      const api = useFileBrowserStoreApi();
      useEffect(() => {
        api.setState((state) => ({
          selection: { ...state.selection, selectedPath: file.path },
          file: { ...state.file, selectedFile: file, content: "a", autoSaveState: "saved" },
        }));
      }, [api]);
      return null;
    }
    return render(
      <FileBrowserStoreProvider config={config}>
        <Seed />
        <FileViewHeader singleFile={singleFile} />
      </FileBrowserStoreProvider>,
    );
  }

  it("says it saved at any width in a single-file browser", async () => {
    renderHeader(true);
    const label = await screen.findByText("Autosaved");
    expect(label.className).not.toContain("hidden");
    expect(screen.queryByText("a.txt")).toBeNull();
  });

  it("keeps it for wide panels in a browser with a file list", async () => {
    renderHeader(false);
    const label = await screen.findByText("Autosaved");
    expect(label.className).toContain("hidden");
    expect(label.className).toContain("@min-[1024px]/fb:inline");
    expect(screen.getByText("a.txt")).toBeTruthy();
  });
});

describe("a file dropped on the browser", () => {
  const dropped = new File(["x"], "dropped.txt", { type: "text/plain" });
  const drop = (target: Element) =>
    fireEvent.drop(target, {
      dataTransfer: {
        types: ["Files"],
        files: [dropped],
        items: [
          {
            webkitGetAsEntry: () => ({
              isFile: true,
              isDirectory: false,
              fullPath: "/dropped.txt",
              file: (done: (file: File) => void) => done(dropped),
            }),
          },
        ],
        dropEffect: "",
      },
    });
  // Uploads go out as an XHR POST, which the stub only counts.
  let posts = 0;
  const realOpen = XMLHttpRequest.prototype.open;
  const realSend = XMLHttpRequest.prototype.send;
  beforeEach(() => {
    posts = 0;
    XMLHttpRequest.prototype.open = function (method: string) {
      if (method === "POST") posts += 1;
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.send = () => undefined;
  });
  afterEach(() => {
    XMLHttpRequest.prototype.open = realOpen;
    XMLHttpRequest.prototype.send = realSend;
  });
  const uploads = () => Array.from({ length: posts });

  it("uploads nothing in a single-file browser", async () => {
    stubApi();
    const { container } = renderBrowser(true);
    await screen.findByTestId("editor");
    drop(container.querySelector("main") as Element);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads()).toHaveLength(0);
  });

  it("is uploaded to the folder as ever where there is a file list", async () => {
    stubApi();
    const { container } = renderBrowser(false);
    await screen.findAllByPlaceholderText("Search projects");
    drop(container.querySelector("main") as Element);
    await waitFor(() => expect(uploads().length).toBeGreaterThan(0));
  });
});

describe("a chat link clicked with edits unsaved", () => {
  const config = {
    apiBasePath: "/api/projects",
    logicalRootPath: "projects",
    rootLabel: "projects",
    initialSelectedFolderPath: null,
    queryClient: new QueryClient(),
    navigate: rs.fn(),
    getRouteSnapshot: () => ({ pathname: "/", search: "", hash: "" }),
    t: i18n.getFixedT("en", "files"),
    embedded: true,
  };
  let dirty = true;

  function Where() {
    return <output data-testid="where">{useLocation().pathname}</output>;
  }
  function Page({ handBack, onLink }: { handBack: boolean; onLink: () => void }) {
    const api = useFileBrowserStoreApi();
    useEffect(() => {
      // Unsaved edits that settle when asked, as an autosave flush does.
      api.setState((state) => ({
        file: {
          ...state.file,
          hasUnsavedEdits: () => dirty,
          resolveUnsavedEditsBeforeLeaving: async () => {
            dirty = false;
            return true;
          },
        },
      }));
    }, [api]);
    useDocumentLinkInterceptor({ handBack });
    return (
      <a
        href="/chat/other"
        onClick={(event) => {
          // As a chat link does: it opens the output itself.
          event.preventDefault();
          onLink();
        }}
      >
        link
      </a>
    );
  }
  function setup(handBack: boolean, onLink: () => void) {
    dirty = true;
    render(
      <MemoryRouter>
        <FileBrowserStoreProvider config={config}>
          <Page handBack={handBack} onLink={onLink} />
        </FileBrowserStoreProvider>
        <Where />
      </MemoryRouter>,
    );
  }

  it("goes back to the link's own handler once settled, and does not navigate", async () => {
    const onLink = rs.fn();
    setup(true, onLink);
    fireEvent.click(screen.getByText("link"));
    await waitFor(() => expect(onLink).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("where").textContent).toBe("/");
  });

  it("still navigates to the href where the browser owns the page", async () => {
    const onLink = rs.fn();
    setup(false, onLink);
    fireEvent.click(screen.getByText("link"));
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/chat/other"));
    expect(onLink).not.toHaveBeenCalled();
  });
});
