// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ProjectsWidget } from "./ProjectsWidget";
import { createWorkspaceStore, WorkspaceStoreContext } from "./workspace-store";

type Selection = {
  selectedPath: string | null;
  currentFolderPath: string | null;
  selectedTreePaths: string[];
};

const browser: {
  onSelectionChange?: (selection: Selection) => void;
  shown: (string | undefined)[];
} = { shown: [] };
const updateProjectsSelection = rs.fn();

rs.mock("@/components/file-browser-page", () => ({
  FileBrowserPage: (props: {
    onSelectionChange?: (selection: Selection) => void;
    externalSelection?: { path: string } | null;
  }) => {
    browser.onSelectionChange = props.onSelectionChange;
    const path = props.externalSelection?.path;
    if (browser.shown.at(-1) !== path) browser.shown.push(path);
    return null;
  },
}));
rs.mock("./use-free-cells", () => ({
  updateProjectsSelection: (...args: unknown[]) => updateProjectsSelection(...args),
}));

function stubResolve(type: string) {
  rs.stubGlobal(
    "fetch",
    rs.fn(async () => new Response(JSON.stringify({ type }), { status: 200 })),
  );
}

function mount(initialSelectedPath?: string, store = createWorkspaceStore()) {
  return render(
    <WorkspaceStoreContext.Provider value={store}>
      <ProjectsWidget dragging={false} placementId="p1" initialSelectedPath={initialSelectedPath} />
    </WorkspaceStoreContext.Provider>,
  );
}

function show(selection: Partial<Selection>) {
  act(() =>
    browser.onSelectionChange?.({
      selectedPath: null,
      currentFolderPath: "projects",
      selectedTreePaths: [],
      ...selection,
    }),
  );
}

beforeEach(() => {
  updateProjectsSelection.mockClear();
  browser.onSelectionChange = undefined;
  browser.shown = [];
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

describe("ProjectsWidget location persistence", () => {
  it("persists nothing for a tile that only shows the root", () => {
    mount();
    show({});
    expect(updateProjectsSelection).toHaveBeenCalledWith("p1", null);
    expect(updateProjectsSelection).not.toHaveBeenCalledWith("p1", "projects");
  });

  it("persists the folder shown, and the open file over it", () => {
    mount();
    show({ currentFolderPath: "projects/docs" });
    expect(updateProjectsSelection).toHaveBeenLastCalledWith("p1", "projects/docs");
    show({ currentFolderPath: "projects/docs", selectedPath: "projects/docs/a.md" });
    expect(updateProjectsSelection).toHaveBeenLastCalledWith("p1", "projects/docs/a.md");
  });

  it("keeps a saved location while it is being restored", async () => {
    stubResolve("directory");
    mount("projects/docs");
    show({});
    expect(updateProjectsSelection).not.toHaveBeenCalled();
    show({ currentFolderPath: "projects/docs" });
    expect(updateProjectsSelection).toHaveBeenLastCalledWith("p1", "projects/docs");
  });

  it("drops a saved location that no longer exists", async () => {
    stubResolve("missing");
    mount("projects/gone");
    show({});
    await waitFor(() => expect(updateProjectsSelection).toHaveBeenCalledWith("p1", null));
  });

  it("does not reopen the saved location between successive agent links", async () => {
    const pending = new Map<string, () => void>();
    rs.stubGlobal(
      "fetch",
      rs.fn(async (url: string) => {
        if (url.includes("c.md")) await new Promise<void>((resolve) => pending.set("c", resolve));
        return new Response(JSON.stringify({ type: "file" }), { status: 200 });
      }),
    );
    const store = createWorkspaceStore();
    mount("projects/saved.md", store);
    await waitFor(() => expect(browser.shown.at(-1)).toBe("projects/saved.md"));
    act(() => store.set("followTargetPath", "projects/b.md"));
    await waitFor(() => expect(browser.shown.at(-1)).toBe("projects/b.md"));
    act(() => store.set("followTargetPath", "projects/c.md"));
    await waitFor(() => expect(pending.has("c")).toBe(true));
    act(() => pending.get("c")?.());
    await waitFor(() => expect(browser.shown.at(-1)).toBe("projects/c.md"));
    expect(browser.shown.filter(Boolean)).toEqual([
      "projects/saved.md",
      "projects/b.md",
      "projects/c.md",
    ]);
  });
});
