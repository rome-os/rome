// @rstest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { act, cleanup, render } from "@testing-library/react";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { FileBrowserStoreProvider, useFileBrowserStoreApi } from "../store/context";
import type { FileBrowserStoreApi } from "../store/create";
import { useSelectionChangeBroadcast } from "./useSelectionChangeBroadcast";

const config = {
  apiBasePath: "/api/projects",
  logicalRootPath: "projects",
  rootLabel: "projects",
  initialSelectedFolderPath: "projects",
  queryClient: new QueryClient(),
  navigate: rs.fn(),
  getRouteSnapshot: () => ({ pathname: "/projects", search: "", hash: "" }),
  t: ((key: string) => key) as TFunction,
  embedded: true,
};

let store: FileBrowserStoreApi | undefined;
function Probe({ compact, onChange }: { compact: boolean; onChange: (folder: unknown) => void }) {
  store = useFileBrowserStoreApi();
  useSelectionChangeBroadcast(compact, (selection) => onChange(selection.currentFolderPath));
  return null;
}
function mount(compact: boolean, onChange: (folder: unknown) => void): ReactNode {
  return (
    <FileBrowserStoreProvider config={config}>
      <Probe compact={compact} onChange={onChange} />
    </FileBrowserStoreProvider>
  );
}

function navigate(folder: string | null, drill: string | null) {
  act(() =>
    store?.setState((s) => ({
      selection: { ...s.selection, selectedFolderPath: folder },
      ui: { ...s.ui, filesPaneDrillPath: drill },
    })),
  );
}

afterEach(() => cleanup());

describe("useSelectionChangeBroadcast currentFolderPath", () => {
  it("reports the drilled folder in the compact layout", () => {
    const onChange = rs.fn();
    render(mount(true, onChange));
    navigate(null, "projects/app/src");
    expect(onChange).toHaveBeenLastCalledWith("projects/app/src");
  });

  it("ignores a stale drill path in the two-pane layout", () => {
    const onChange = rs.fn();
    render(mount(false, onChange));
    navigate("projects/research", "projects/app/src");
    expect(onChange).toHaveBeenLastCalledWith("projects/research");
  });
});
