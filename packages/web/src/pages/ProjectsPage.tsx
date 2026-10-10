import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { FileBrowserPage } from "@/components/file-browser-page";
import type { DeleteDescriptionResolver } from "@/components/file-browser/store/types";
import { ProjectDashboard } from "@/components/projects/ProjectDashboard";
import { SourceConnect } from "@/components/sync/SourceConnect";
import {
  NewFolderSyncSection,
  type NewFolderLinkChoice,
} from "@/components/sync/NewFolderSyncSection";
import { emitSessionsChanged } from "@/lib/session-events";

const LARGE_TEXT_FILE_BYTES = 1024 * 1024;
const STANDARD_AUTOSAVE_DELAY_MS = 2000;
const LARGE_FILE_AUTOSAVE_DELAY_MS = 5000;

function getProjectsAutoSavePolicy(file: {
  editable: boolean;
  kind: string;
  path: string;
  size: number;
}) {
  if (!file.editable || file.kind !== "text") return null;
  if (!/\.(md|mdx|txt)$/i.test(file.path)) return null;

  return {
    commit: false,
    delayMs:
      file.size > LARGE_TEXT_FILE_BYTES ? LARGE_FILE_AUTOSAVE_DELAY_MS : STANDARD_AUTOSAVE_DELAY_MS,
  };
}

function isProjectChildPath(path: string): boolean {
  return path.startsWith("projects/") && path.length > "projects/".length;
}

function getProjectName(path: string): string {
  return path.slice("projects/".length);
}

export default function ProjectsPage() {
  const { t } = useTranslation("files");
  const navigate = useNavigate();
  const location = useLocation();

  // The optional source link is captured inside
  // the create dialog (NewFolderSyncSection) via a ref so it doesn't churn the
  // memoized file-browser config; on create we proceed to the connect wizard
  // only when the user picked a source.
  const linkChoiceRef = useRef<NewFolderLinkChoice>("none");
  const [connectProjectPath, setConnectProjectPath] = useState<string | null>(null);

  const getDeleteDescription = useCallback<DeleteDescriptionResolver>(
    ({ entries, defaultDescription }) => {
      const projectDirectories = entries.filter(
        (entry) => entry.type === "directory" && isProjectChildPath(entry.path),
      );
      if (projectDirectories.length === 0) return defaultDescription;
      return projectDirectories.length === 1 && entries.length === 1
        ? t("projects.deleteProjectDescription", {
            name: getProjectName(projectDirectories[0].path),
          })
        : t("projects.deleteProjectsDescription", { count: projectDirectories.length });
    },
    [t],
  );

  const renderCreateExtra = useCallback(
    ({ type, parentPath }: { type: "file" | "folder"; parentPath: string | null }) => {
      if (type !== "folder") return null;
      return (
        <NewFolderSyncSection
          parentPath={parentPath}
          onChoiceChange={(choice) => {
            linkChoiceRef.current = choice;
          }}
        />
      );
    },
    [],
  );

  const startChatFromFolder = (path: string) => {
    const projectPath = path.replace(/^projects\/?/, "");
    if (!projectPath) return;
    const hideSidebar = new URLSearchParams(location.search).get("hideSidebar");
    navigate(hideSidebar === "1" ? "/chat?hideSidebar=1" : "/chat", {
      state: { projectPath },
    });
  };

  const handleFolderCreated = (createdPath: string) => {
    const choice = linkChoiceRef.current;
    linkChoiceRef.current = "none";
    // Link the folder that was just created (at whatever depth), but only if the
    // user opted into a source in the dialog. The dialog already suppresses the
    // choice when the location sits inside an already-synced tree.
    const projectPath = createdPath.replace(/^\/?projects\/?/, "").replace(/^\/+|\/+$/g, "");
    if (choice === "git" && projectPath) {
      setConnectProjectPath(projectPath);
    }
  };

  const handlePathsDeleted = useCallback((paths: string[]) => {
    if (!paths.some((path) => path.startsWith("projects/"))) return;
    emitSessionsChanged();
  }, []);

  return (
    <>
      <FileBrowserPage
        apiBasePath="/api/projects"
        autoSave={getProjectsAutoSavePolicy}
        folderPanel={({ path }) => (
          <ProjectDashboard onStartChat={startChatFromFolder} path={path} />
        )}
        getDeleteDescription={getDeleteDescription}
        initialSelectedFolderPath="projects"
        logicalRootPath="projects"
        onStartChatFromFolder={startChatFromFolder}
        onPathsDeleted={handlePathsDeleted}
        onFolderCreated={handleFolderCreated}
        renderCreateExtra={renderCreateExtra}
        rootLabel={t("projects.rootLabel")}
        rootPanelTrigger
        searchPlaceholder={t("projects.searchPlaceholder")}
        sidebarHeading={t("projects.title")}
      />
      {connectProjectPath ? (
        <SourceConnect
          mode="link"
          projectPath={connectProjectPath}
          open={!!connectProjectPath}
          onClose={() => setConnectProjectPath(null)}
        />
      ) : null}
    </>
  );
}
