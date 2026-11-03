import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ContextMenuActions } from "../ContextMenu";
import { useFileBrowserStore, useFileBrowserStoreApi } from "../store/context";
import { findTreeNode } from "../store/utils";

export function useContextMenuActions({
  rootLabel,
  onStartChatFromFolder,
}: {
  rootLabel: string;
  onStartChatFromFolder?: (path: string) => void;
}): ContextMenuActions {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const logicalRootPath = useFileBrowserStore((s) => s.config.logicalRootPath);
  const creating = useFileBrowserStore((s) => s.ui.creating);
  const deleting = useFileBrowserStore((s) => s.ui.deleting);
  const renaming = useFileBrowserStore((s) => s.ui.renaming);
  const moving = useFileBrowserStore((s) => s.ui.moving);

  return useMemo(
    () => ({
      creating,
      renaming,
      moving,
      deleting,
      logicalRootPath,
      rootLabel,
      canStartChatFromFolder: Boolean(onStartChatFromFolder),
      onCreatePath: (type, parentPath) => store.getState().ui.createPath(type, parentPath),
      onCopyPath: (text) => void store.getState().ui.copyPath(text),
      getPathKind: (path) => findTreeNode(store.getState().tree.nodes, path)?.type ?? null,
      onDownloadPaths: (paths) => store.getState().ui.downloadPaths(paths),
      onUploadForFolder: (path) => store.getState().ui.triggerUploadForFolder(path),
      onUploadFolderForFolder: (path) => store.getState().ui.triggerFolderUploadForFolder(path),
      onStartChatHere: (path) => onStartChatFromFolder?.(path),
      onRenamePath: (path) => store.getState().ui.renamePath(path),
      onRequestMovePath: (path) => store.getState().ui.requestMovePath(path),
      onRequestDeletePaths: (paths) => store.getState().ui.requestDeletePaths(paths),
      labelSelectedItems: (count) => t("contextMenu.selectedItems", { count }),
      labelNewFile: t("contextMenu.newFile"),
      labelNewFolder: t("contextMenu.newFolder"),
      labelCopyPath: t("contextMenu.copyPath"),
      labelCopyPaths: t("contextMenu.copyPaths"),
      labelDownload: t("contextMenu.download"),
      labelUploadFiles: t("contextMenu.uploadFiles"),
      labelUploadFolder: t("contextMenu.uploadFolder"),
      labelStartChatHere: t("contextMenu.startChatHere"),
      labelRename: t("contextMenu.rename"),
      labelMoveTo: t("contextMenu.moveTo"),
      labelDelete: t("contextMenu.delete"),
      labelMoreActions: (name) => t("contextMenu.moreActions", { name }),
      labelActionsFor: (name) => t("contextMenu.actionsFor", { name }),
      labelCloseActions: t("contextMenu.closeActions"),
    }),
    [
      creating,
      deleting,
      logicalRootPath,
      moving,
      onStartChatFromFolder,
      renaming,
      rootLabel,
      store,
      t,
    ],
  );
}
