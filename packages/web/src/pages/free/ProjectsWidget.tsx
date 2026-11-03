import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBrowserPage } from "@/components/file-browser-page";
import { useResolvedSelection } from "@/components/file-browser/hooks/useResolvedSelection";
import { getSession } from "@/lib/chat-api";
import { updateProjectsSelection } from "./use-free-cells";
import { projectsLocation } from "./widget-links";
import { buildProjectsBuiltin, useWorkspaceContextRegistry } from "./workspace-context";
import { useWorkspaceValue } from "./workspace-store";

interface ProjectsWidgetProps {
  dragging: boolean;
  /** Placement id — selection changes are persisted back onto this placement. */
  placementId?: string;
  /** File or folder selected before the last reload, restored once on mount. */
  initialSelectedPath?: string;
}

function useActiveProjectPath(): string | null {
  const activeSessionId = useWorkspaceValue<string | null>("activeSessionId");
  const [projectPath, setProjectPath] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    getSession(activeSessionId)
      .then((session) => {
        if (!cancelled) setProjectPath(session?.projectPath ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  return projectPath;
}

const PROJECTS_SLOT_ID = "projects";

export function ProjectsWidget({
  dragging,
  placementId,
  initialSelectedPath,
}: ProjectsWidgetProps) {
  const { t: tFiles } = useTranslation("files");
  const registry = useWorkspaceContextRegistry();
  // File-following follows a single shared signal: `followTargetPath`, published
  // by ChatWidget from the link the agent presents in its own message (markdown
  // links rooted at `/projects/`). All intermediate trace activity — `tool_use`
  // inputs and `tool_result` outputs alike — is deliberately ignored upstream;
  // those surface files the agent merely touched, which is what kept yanking the
  // view to images named by a mid-turn `ls`/`file`/script output. ChatWidget owns
  // the extraction so the signal rides the authoritative chat stream rather than a
  // second per-turn subscription that could be aborted before the terminal
  // segment is read. Following is always on: navigation now fires only on the
  // agent's deliberate end-of-turn links, which is unobtrusive enough that no
  // opt-out toggle is needed, and a manual selection is never overridden until the
  // next link arrives.
  const targetPath = useWorkspaceValue<string | null>("followTargetPath") ?? null;
  const activeProjectPath = useActiveProjectPath();

  // Restore the file selected before the last reload. Frozen at mount so our
  // own persistence (which updates the placement on every selection change)
  // doesn't re-resolve and yank the view around as the user navigates. The
  // agent follow target, when present, takes precedence below.
  const [restorePath] = useState<string | null>(() => initialSelectedPath ?? null);
  const restored = useResolvedSelection("/api/projects", restorePath);
  // Until the browser reaches the restored spot (or navigates elsewhere), its
  // empty mount state must not overwrite the saved location.
  const restorePendingRef = useRef(restorePath !== null);
  // A saved path that no longer exists will never be reached: release the
  // guard and drop it, so the placement and its link follow what is shown.
  // A failed lookup is not proof of absence, so it keeps the saved path.
  useEffect(() => {
    if (!restored.missing || !restorePendingRef.current) return;
    restorePendingRef.current = false;
    if (placementId) updateProjectsSelection(placementId, null);
  }, [restored.missing, placementId]);

  const candidatePath = useMemo(() => {
    if (!targetPath) return null;
    if (targetPath.startsWith("projects/")) return targetPath;
    const marker = "/projects/";
    const idx = targetPath.indexOf(marker);
    if (idx >= 0) return targetPath.slice(idx + 1);
    if (!targetPath.startsWith("/") && activeProjectPath) {
      return `projects/${activeProjectPath}/${targetPath}`;
    }
    return null;
  }, [targetPath, activeProjectPath]);

  const { selection: followTarget } = useResolvedSelection("/api/projects", candidatePath);
  // Agent follow wins when present; otherwise fall back to the restored
  // selection. `useExternalSelection` only re-selects when this value's path
  // changes and no-ops if the browser is already there, so a manual selection
  // after restore is never overridden.
  const externalSelection = followTarget ?? restored.selection;

  // Publish a workspace-context snapshot driven by the file
  // browser's own selection (`onSelectionChange`) so it works on the first
  // turn — before any agent session exists — and reflects the user's
  // multi-select set, not just whichever file we're auto-following.
  const [browserSelection, setBrowserSelection] = useState<{
    selectedPath: string | null;
    selectedTreePaths: string[];
  }>({ selectedPath: null, selectedTreePaths: [] });
  const handleSelectionChange = useCallback(
    (sel: {
      selectedPath: string | null;
      currentFolderPath: string | null;
      selectedTreePaths: string[];
    }) => {
      // Keep the previous object when only the folder moved, so drilling does
      // not republish an identical context snapshot.
      setBrowserSelection((prev) =>
        prev.selectedPath === sel.selectedPath && prev.selectedTreePaths === sel.selectedTreePaths
          ? prev
          : { selectedPath: sel.selectedPath, selectedTreePaths: sel.selectedTreePaths },
      );
      // Persist wherever the user is — the open file, or the folder the
      // browser is showing when no file is open. The restore path already
      // resolves either kind through `/resolve`.
      const location = projectsLocation(sel);
      if (restorePendingRef.current) {
        if (location === null) return;
        restorePendingRef.current = false;
      }
      if (placementId) updateProjectsSelection(placementId, location);
    },
    [placementId],
  );
  useEffect(() => {
    if (!registry) return;
    const focused = browserSelection.selectedPath;
    const tree = browserSelection.selectedTreePaths;
    const paths = tree.length > 0 ? tree : focused ? [focused] : [];
    const files = paths.map((p) => ({ path: p, focused: p === focused }));
    registry.setBuiltin(
      PROJECTS_SLOT_ID,
      buildProjectsBuiltin({ project: activeProjectPath ?? null, files }),
    );
  }, [registry, activeProjectPath, browserSelection]);
  useEffect(() => {
    if (!registry) return;
    return () => {
      registry.setBuiltin(PROJECTS_SLOT_ID, null);
    };
  }, [registry]);

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        <FileBrowserPage
          apiBasePath="/api/projects"
          embedded
          externalSelection={externalSelection}
          initialSelectedFolderPath="projects"
          logicalRootPath="projects"
          onSelectionChange={handleSelectionChange}
          rootLabel={tFiles("projects.rootLabel")}
          rootPanelTrigger
          searchPlaceholder={tFiles("projects.searchPlaceholder")}
          sidebarHeading={tFiles("projects.title")}
        />
      </div>
      {dragging && <div className="absolute inset-0 z-10" />}
    </div>
  );
}
