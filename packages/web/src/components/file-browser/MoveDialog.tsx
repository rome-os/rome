import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { FileBrowserTreeNode } from "@/lib/file-browser-tree";
import { PathBreadcrumb } from "./PathBreadcrumb";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";
import { getBaseName, getParentPath, isPathWithin } from "./store/utils";

/**
 * Destination picker for "Move to…".
 *
 * A drill-down navigator rather than an expandable tree: it renders and behaves
 * identically at every panel width and on touch, which is the whole reason this
 * command exists — tree drag/drop is only reachable once the browser panel is
 * wide enough to render the Sidebar.
 */
export function MoveDialog() {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const moveDialog = useFileBrowserStore((s) => s.ui.moveDialog);
  const moving = useFileBrowserStore((s) => s.ui.moving);
  const apiBasePath = useFileBrowserStore((s) => s.config.apiBasePath);
  const logicalRootPath = useFileBrowserStore((s) => s.config.logicalRootPath);
  const rootLabel = useFileBrowserStore((s) => s.config.rootLabel);

  const [children, setChildren] = useState<FileBrowserTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Initial focus goes to the folder list, not the confirm button: the dialog
  // always opens at the item's current parent, so confirm is always disabled at
  // mount and browsers refuse to focus a disabled element. The list is also the
  // control the user actually needs first — picking a destination.
  const listRef = useRef<HTMLDivElement | null>(null);

  const currentPath = moveDialog?.currentPath ?? null;
  const movingPath = moveDialog?.path ?? null;
  const movingName = movingPath ? getBaseName(movingPath) : "";

  // Listing is fetched at depth 1 and includes files as well as folders: only
  // folders are enterable rows, but a file with the moving item's name is still
  // a name conflict the server would reject with a 409.
  useEffect(() => {
    if (!currentPath) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const params = new URLSearchParams({ depth: "1" });
    if (currentPath !== logicalRootPath) params.set("path", currentPath);
    void fetch(`${apiBasePath}/tree?${params.toString()}`)
      .then(async (response) => {
        const data = (await response.json()) as FileBrowserTreeNode[] | { error?: string };
        if (cancelled) return;
        if (!response.ok || !Array.isArray(data)) {
          setChildren([]);
          setLoadError(t("status.networkError"));
          return;
        }
        setChildren(data);
      })
      .catch(() => {
        if (!cancelled) {
          setChildren([]);
          setLoadError(t("status.networkError"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBasePath, currentPath, logicalRootPath, t]);

  const goTo = useCallback(
    (path: string) => {
      const dialog = store.getState().ui.moveDialog;
      if (!dialog) return;
      store.getState().ui.setMoveDialog({ ...dialog, currentPath: path });
    },
    [store],
  );

  const folders = useMemo(() => children.filter((node) => node.type === "directory"), [children]);

  const crumbs = useMemo(() => {
    if (!currentPath) return [];
    const relative =
      currentPath === logicalRootPath ? "" : currentPath.slice(logicalRootPath.length + 1);
    const parts = relative ? relative.split("/") : [];
    return [
      { path: logicalRootPath, label: rootLabel },
      ...parts.map((name, index) => ({
        label: name,
        path: [logicalRootPath, ...parts.slice(0, index + 1)].join("/"),
      })),
    ];
  }, [currentPath, logicalRootPath, rootLabel]);

  if (!moveDialog || !currentPath || !movingPath) return null;

  // A folder inside the moving directory can never receive it.
  const isInvalidDestination = (path: string) =>
    path === movingPath || isPathWithin(path, movingPath);

  const conflictingName = children.some(
    (node) => node.name === movingName && node.path !== movingPath,
  );
  const isCurrentParent = currentPath === getParentPath(movingPath, logicalRootPath);
  const isSelfOrDescendant = isInvalidDestination(currentPath);
  // `loadError` gates confirm too: on a failed listing fetch `children` is empty,
  // so `conflictingName` would be silently false and the move would proceed with
  // no name-conflict pre-check, leaning entirely on the server's 409.
  const canMove =
    !moving &&
    !loading &&
    !loadError &&
    !conflictingName &&
    !isCurrentParent &&
    !isSelfOrDescendant;

  const blockedReason = conflictingName
    ? t("moveDialog.nameTaken", { name: movingName })
    : isCurrentParent
      ? t("moveDialog.alreadyHere")
      : null;

  return (
    <Dialog
      open
      onClose={() => store.getState().ui.setMoveDialog(null)}
      size="md"
      ariaLabel={t("moveDialog.title", { name: movingName })}
      initialFocusRef={listRef}
      className="p-6"
    >
      <div>
        <DialogTitle>{t("moveDialog.title", { name: movingName })}</DialogTitle>
        <DialogDescription className="mt-2">{t("moveDialog.description")}</DialogDescription>
      </div>

      <PathBreadcrumb
        aria-label={t("moveDialog.breadcrumbLabel")}
        crumbs={crumbs}
        onNavigate={goTo}
        className="mt-4"
        listClassName="-ml-1"
      />

      <div
        ref={listRef}
        tabIndex={-1}
        aria-label={t("moveDialog.description")}
        className="mt-3 h-64 overflow-auto rounded-8 border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {loading ? (
          <p className="p-4 text-ui text-muted-foreground">{t("pane.loading")}</p>
        ) : loadError ? (
          <p className="p-4 text-ui text-destructive">{loadError}</p>
        ) : folders.length === 0 ? (
          <p className="p-4 text-ui text-muted-foreground">{t("moveDialog.noSubfolders")}</p>
        ) : (
          <ul>
            {folders.map((folder) => {
              const invalid = isInvalidDestination(folder.path);
              return (
                <li key={folder.path}>
                  <button
                    type="button"
                    disabled={invalid}
                    onClick={() => goTo(folder.path)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-foreground hover:bg-surface-muted disabled:cursor-not-allowed disabled:text-subtle-foreground disabled:hover:bg-transparent"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-subtle-foreground" />
                    <span className="flex-1 truncate">{folder.name}</span>
                    {invalid ? (
                      <span className="shrink-0 text-aux text-subtle-foreground">
                        {folder.path === movingPath
                          ? t("moveDialog.reasonSelf")
                          : t("moveDialog.reasonInside")}
                      </span>
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-subtle-foreground" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-3 flex min-h-5 items-start gap-2 text-ui">
        <FolderOpen className="mt-1 h-4 w-4 shrink-0 text-subtle-foreground" />
        <p className="text-muted-foreground">
          {blockedReason ??
            t("moveDialog.target", {
              target: currentPath === logicalRootPath ? rootLabel : getBaseName(currentPath),
            })}
        </p>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={() => store.getState().ui.setMoveDialog(null)}>
          {t("dialog.cancel")}
        </Button>
        <Button
          disabled={!canMove}
          onClick={async () => {
            // `movePathToFolder` owns the guards, the PATCH and the refresh, and
            // reports failures as toasts; the dialog only decides whether to close.
            if (await store.getState().ui.movePathToFolder(movingPath, currentPath)) {
              store.getState().ui.setMoveDialog(null);
            }
          }}
        >
          {moving ? t("status.moving") : t("moveDialog.confirm")}
        </Button>
      </div>
    </Dialog>
  );
}
