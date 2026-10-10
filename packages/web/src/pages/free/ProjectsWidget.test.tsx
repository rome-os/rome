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

const browser: { onSelectionChange?: (selection: Selection) => void } = {};
const updateProjectsSelection = rs.fn();

rs.mock("@/components/file-browser-page", () => ({
  FileBrowserPage: (props: { onSelectionChange?: (selection: Selection) => void }) => {
    browser.onSelectionChange = props.onSelectionChange;
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

function mount(initialSelectedPath?: string) {
  return render(
    <WorkspaceStoreContext.Provider value={createWorkspaceStore()}>
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
});
