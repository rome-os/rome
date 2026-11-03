// Pre-send workspace-context chips. Session model: docs/concepts/sessions.md.
//
// Subscribes to the workspace-context registry and shows what will be
// injected into the next turn. Built-ins push details directly; app
// entries show only `appId` (with the app's real icon + display name)
// because the URL isn't resolved until send time. A compact "+N" pill
// collapses overflow past the first few chips.

import type { InstalledAppCard } from "@rome/api-types/apps";
import type { TFunction } from "i18next";
import { Chrome, FolderKanban } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useApps } from "@/hooks/use-apps";
import { appDisplayName } from "@/lib/app-display-name";
import {
  useWorkspaceContextRegistry,
  type WorkspaceContextBuiltin,
} from "@/pages/free/workspace-context";
import { ComposerChip } from "./ComposerChip";

const NO_OP = () => () => {};
const ZERO_VERSION = () => 0;
const VISIBLE_LIMIT = 3;

interface ChipModel {
  key: string;
  icon: ReactNode;
  label: ReactNode;
  detail: string;
}

function projectsChip(
  b: Extract<WorkspaceContextBuiltin, { kind: "projects" }>,
  t: TFunction<"common">,
): ChipModel {
  const name = t("nav.projects");
  const fileCount = b.files.filter((f) => !f.path.startsWith("… (")).length;
  const head = b.project ? `${name} · ${b.project}` : name;
  const detail = [
    head,
    ...b.files.map((f) => `  - ${f.path}${f.focused ? " (focused)" : ""}`),
  ].join("\n");
  const trail =
    fileCount > 0 ? (
      <span className="text-subtle-foreground">
        {" "}
        <span className="opacity-50">·</span> {fileCount} file{fileCount === 1 ? "" : "s"}
      </span>
    ) : null;
  return {
    key: `projects:${b.project ?? "_"}`,
    icon: <FolderKanban className="size-3.5 shrink-0 opacity-70" />,
    label: (
      <span>
        {b.project ? (
          <>
            {name} <span className="opacity-50">·</span> {b.project}
          </>
        ) : (
          name
        )}
        {trail}
      </span>
    ),
    detail,
  };
}

function desktopChip(
  b: Extract<WorkspaceContextBuiltin, { kind: "desktop" }>,
  t: TFunction<"common">,
): ChipModel {
  return {
    key: "desktop",
    icon: <Chrome className="size-3.5 shrink-0 opacity-70" />,
    label: <span>{t("nav.desktop")}</span>,
    detail: b.line,
  };
}

function appChip(
  appId: string,
  placementId: string,
  apps: InstalledAppCard[] | null,
  placeholder: string,
): ChipModel {
  const info = apps?.find((app) => app.id === appId);
  const displayName = appDisplayName(appId, apps, placeholder);
  const icon = info?.iconUrl ? (
    <img src={info.iconUrl} alt="" className="size-3.5 shrink-0 rounded-4" />
  ) : (
    <span className="flex size-3.5 shrink-0 items-center justify-center rounded-4 bg-surface-muted text-badge text-muted-foreground">
      {displayName.charAt(0).toUpperCase()}
    </span>
  );
  return {
    key: `app:${placementId}:${appId}`,
    icon,
    label: <span>{displayName}</span>,
    detail: "Current page, captured on send.",
  };
}

export function WorkspaceContextChips() {
  const { t } = useTranslation("common");
  const registry = useWorkspaceContextRegistry();
  const { apps } = useApps();
  const [expanded, setExpanded] = useState(false);

  useSyncExternalStore(
    registry ? registry.subscribe : NO_OP,
    registry ? registry.getVersion : ZERO_VERSION,
    registry ? registry.getVersion : ZERO_VERSION,
  );

  if (!registry) return null;

  const chips: ChipModel[] = [
    ...registry
      .getBuiltins()
      .map((b) => (b.kind === "projects" ? projectsChip(b, t) : desktopChip(b, t))),
    ...registry
      .listApps()
      .map(({ placementId, appId }) => appChip(appId, placementId, apps, t("nav.apps"))),
  ];

  if (chips.length === 0) return null;

  const visible = expanded ? chips : chips.slice(0, VISIBLE_LIMIT);
  const hidden = expanded ? [] : chips.slice(VISIBLE_LIMIT);

  // No own container/margin — the chips flow as siblings into the composer's
  // single pre-send row (TooltipProvider renders no DOM node of its own).
  return (
    <TooltipProvider delayDuration={150}>
      {visible.map((chip) => (
        <Tooltip key={chip.key}>
          <TooltipTrigger asChild>
            <ComposerChip icon={chip.icon} className="cursor-default">
              {chip.label}
            </ComposerChip>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-line text-aux">
            {chip.detail}
          </TooltipContent>
        </Tooltip>
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => setExpanded(true)}
              className="text-subtle-foreground"
            >
              +{hidden.length}
            </Button>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm whitespace-pre-line text-aux">
            {hidden.map((c) => c.detail).join("\n\n")}
          </TooltipContent>
        </Tooltip>
      )}
    </TooltipProvider>
  );
}
