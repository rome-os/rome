import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, rs } from "@rstest/core";
import type { TFunction } from "i18next";
import { createFileBrowserStore } from "./create";

function createTestStore() {
  return createFileBrowserStore({
    apiBasePath: "/api/files",
    logicalRootPath: "/projects",
    rootLabel: "projects",
    initialSelectedFolderPath: "/projects/current",
    queryClient: new QueryClient(),
    navigate: rs.fn(),
    getRouteSnapshot: () => ({ pathname: "/projects/current", search: "", hash: "" }),
    t: ((key: string) => key) as TFunction,
    embedded: false,
  });
}

describe("file-browser action selection", () => {
  it("prepares folder action paths without changing folder navigation", () => {
    const store = createTestStore();
    store.setState((state) => ({
      selection: {
        ...state.selection,
        selectedFolderPath: "/projects/current",
        selectedTreePaths: ["/projects/current"],
      },
      ui: { ...state.ui, filesPaneDrillPath: "/projects/current" },
    }));

    const paths = store
      .getState()
      .selection.prepareContextMenu({ path: "/projects/other", type: "directory" });

    expect(paths).toEqual(["/projects/other"]);
    expect(store.getState().selection.selectedTreePaths).toEqual(["/projects/other"]);
    expect(store.getState().selection.selectedFolderPath).toBe("/projects/current");
    expect(store.getState().ui.filesPaneDrillPath).toBe("/projects/current");
  });

  it("waits for the app confirmation dialog before discarding unsaved edits", async () => {
    const store = createTestStore();
    store.setState((state) => ({
      file: {
        ...state.file,
        selectedFile: {
          assetUrl: null,
          content: "saved",
          editable: true,
          kind: "text",
          mimeType: "text/plain",
          path: "/projects/current/notes.txt",
          size: 5,
        },
        content: "draft",
        committedContent: "saved",
        lastDiskContent: "saved",
      },
    }));

    const cancelled = store.getState().file.resolveUnsavedEditsBeforeLeaving();
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(true);
    store.getState().ui.resolveDiscardChangesConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(store.getState().file.content).toBe("draft");

    const confirmed = store.getState().file.resolveUnsavedEditsBeforeLeaving();
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(true);
    store.getState().ui.resolveDiscardChangesConfirm(true);
    await expect(confirmed).resolves.toBe(true);
    expect(store.getState().ui.discardChangesConfirmOpen).toBe(false);
    expect(store.getState().file.content).toBe("saved");
  });
});
