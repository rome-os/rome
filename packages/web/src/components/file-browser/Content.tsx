import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";
import { SearchResults } from "./SearchResults";
import { FileViewHeader, FileViewBody } from "./FileView";
import { HistoryPanel, HistoryMobileSheet } from "./HistoryPanel";

interface ContentProps {
  folderPanel?: (props: { path: string }) => ReactNode;
  /** Always shown, with no way back to a file list that is not there. */
  singleFile?: boolean;
}

export function Content({ folderPanel, singleFile = false }: ContentProps) {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const selectedPath = useFileBrowserStore((s) => s.selection.selectedPath);
  const selectedFolderPath = useFileBrowserStore((s) => s.selection.selectedFolderPath);
  const showSearch = useFileBrowserStore((s) => s.ui.showSearch);
  const showHistory = useFileBrowserStore((s) => s.ui.showHistory);

  const hasFolderPanel = Boolean(folderPanel && selectedFolderPath);
  const hasContentPanel = Boolean(selectedPath || showSearch || hasFolderPanel);

  // When compact (panel below the two-pane breakpoint), the navigator
  // (FilesPane) and Content are siblings; Content overlays the panel when active
  // and the back icon clears whichever state opened it, returning the user to
  // the navigator. At the wider two-pane width Content is always visible. The
  // `@min-[…]/fb:` breakpoint keys off the panel's own width (see Shell), not
  // the viewport — so an embedded narrow panel hides the empty Content instead
  // of leaving a dead "select a file" pane next to the navigator.
  const handleMobileBack = () => {
    const state = store.getState();
    if (state.ui.showSearch) {
      state.ui.setShowSearch(false);
      return;
    }
    void state.selection.guardedSelectFolder(null);
  };

  return (
    <section
      className={`${
        hasContentPanel || singleFile ? "flex" : "hidden @min-[1024px]/fb:flex"
      } flex-1 flex-col overflow-hidden`}
    >
      {showSearch ? (
        <SearchResults onMobileBack={handleMobileBack} />
      ) : selectedPath ? (
        <>
          <FileViewHeader
            onMobileBack={singleFile ? undefined : handleMobileBack}
            singleFile={singleFile}
          />
          <div className="flex flex-1 overflow-hidden">
            <div className="flex-1 overflow-hidden">
              <FileViewBody />
            </div>
            {showHistory && <HistoryPanel />}
          </div>
        </>
      ) : hasFolderPanel && selectedFolderPath ? (
        folderPanel!({ path: selectedFolderPath })
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-ui text-subtle-foreground">{t("view.selectAFile")}</p>
        </div>
      )}
    </section>
  );
}

export { HistoryMobileSheet };
