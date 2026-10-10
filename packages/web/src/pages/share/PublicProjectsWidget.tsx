import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileBrowserPage } from "@/components/file-browser-page";
import type { ExternalSelection } from "@/components/file-browser/store/types";

interface PublicProjectsWidgetProps {
  // Share bearer token — scopes the file API to `/api/share/:token/projects`.
  token: string;
  // The file frozen into the shared layout, restored on mount.
  initialSelectedPath?: string;
}

// Read-only projects browser for the public share page. Points the file browser
// at the token-gated public endpoint (read handlers only); none of the live
// workspace wiring (agent file-following, selection persistence) applies.
export function PublicProjectsWidget({ token, initialSelectedPath }: PublicProjectsWidgetProps) {
  const { t: tFiles } = useTranslation("files");
  const [externalSelection] = useState<ExternalSelection | null>(() =>
    initialSelectedPath ? { path: initialSelectedPath, type: "file" } : null,
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        <FileBrowserPage
          apiBasePath={`/api/share/${encodeURIComponent(token)}/projects`}
          embedded
          externalSelection={externalSelection}
          initialSelectedFolderPath="projects"
          logicalRootPath="projects"
          rootLabel={tFiles("projects.rootLabel")}
          rootPanelTrigger
          searchPlaceholder={tFiles("projects.searchPlaceholder")}
          sidebarHeading={tFiles("projects.title")}
        />
      </div>
    </div>
  );
}
