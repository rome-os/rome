import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBrowserPage } from "@/components/file-browser-page";
import type { ExternalSelection, ResolveResult } from "@/components/file-browser/store/types";
import { getSession } from "@/lib/chat-api";
import { updateProjectsSelection } from "./use-free-cells";
import { buildProjectsBuiltin, useWorkspaceContextRegistry } from "./workspace-context";
import { useWorkspaceValue } from "./workspace-store";

interface ProjectsWidgetProps {
  dragging: boolean;
  /** Placement id — selection changes are persisted back onto this placement. */
  placementId?: string;
  /** File or folder selected before the last reload, restored once on mount. */
  initialSelectedPath?: string;
}

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
function useFileFollowing(): string | null {
  return useWorkspaceValue<string | null>("followTargetPath") ?? null;
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

// The agent links files and folders alike; `/resolve` tells us which one this
// is so a folder link selects the folder in the tree instead of being dropped
// by a file-only check (which left the freshly opened panel empty).
function useResolvedFollowTarget(candidatePath: string | null): ExternalSelection | null {
  const [target, setTarget] = useState<ExternalSelection | null>(null);

  useEffect(() => {
    if (!candidatePath) {
      setTarget(null);
      return;
    }

    let cancelled = false;
    fetch(`/api/projects/resolve?path=${encodeURIComponent(candidatePath)}`, {
      credentials: "include",
    })
      .then(async (res) => {
        const data = res.ok ? ((await res.json()) as ResolveResult) : null;
        if (cancelled) return;
        setTarget(
          data?.type === "file" || data?.type === "directory"
            ? { path: candidatePath, type: data.type }
            : null,
        );
      })
      .catch(() => {
        if (!cancelled) setTarget(null);
      });

    return () => {
      cancelled = true;
    };
  }, [candidatePath]);

  return target;
}

const PROJECTS_SLOT_ID = "projects";

export function ProjectsWidget({
  dragging,
  placementId,
  initialSelectedPath,
}: ProjectsWidgetProps) {
  const { t: tFiles } = useTranslation("files");
  const registry = useWorkspaceContextRegistry();
  const targetPath = useFileFollowing();
  const activeProjectPath = useActiveProjectPath();

  // Restore the file selected before the last reload. Frozen at mount so our
  // own persistence (which updates the placement on every selection change)
  // doesn't re-resolve and yank the view around as the user navigates. The
  // agent follow target, when present, takes precedence below.
  const [restorePath] = useState<string | null>(() => initialSelectedPath ?? null);
  const restoredTarget = useResolvedFollowTarget(restorePath);

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

  const followTarget = useResolvedFollowTarget(candidatePath);
  // Agent follow wins when present; otherwise fall back to the restored
  // selection. `useExternalSelection` only re-selects when this value's path
  // changes and no-ops if the browser is already there, so a manual selection
  // after restore is never overridden.
  const externalSelection = followTarget ?? restoredTarget;

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
      setBrowserSelection(sel);
      // Persist wherever the user is — the open file, or the folder the
      // browser is showing when no file is open. The restore path already
      // resolves either kind through `/resolve`.
      if (placementId) {
        updateProjectsSelection(placementId, sel.selectedPath ?? sel.currentFolderPath);
      }
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
          selectInitialFolderOnMobile={false}
          searchPlaceholder={tFiles("projects.searchPlaceholder")}
          sidebarHeading={tFiles("projects.title")}
          title={tFiles("projects.title")}
        />
      </div>
      {dragging && <div className="absolute inset-0 z-10" />}
    </div>
  );
}
