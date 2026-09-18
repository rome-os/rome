import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, Fingerprint, FolderOpen, NotebookPen, Users } from "lucide-react";
import { FileBrowserPage } from "@/components/file-browser-page";
import { SyncStatusPanel } from "@/components/sync/SyncStatusPanel";

/** Reserved sync key for the memory dir — mirrors `MEMORY_SYNC_KEY` in the
 * backend sync routes. Memory rides the same sync stack as projects. */
const MEMORY_SYNC_KEY = "@memory";

const LARGE_TEXT_FILE_BYTES = 1024 * 1024;
const STANDARD_AUTOSAVE_DELAY_MS = 2000;
const LARGE_FILE_AUTOSAVE_DELAY_MS = 5000;

function getMemoryAutoSavePolicy(file: {
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

function MemoryCategory({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-8 border border-border bg-surface-muted/40 px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="truncate text-ui text-foreground">{label}</span>
    </div>
  );
}

/** Shown in the folder-panel area (when no file is open): a centered intro to
 * Memory plus the GitHub backup / sync status. */
function MemoryFolderPanel() {
  const { t } = useTranslation("files");
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto bg-background px-6 py-10">
      <div className="my-auto w-full max-w-lg space-y-5">
        <section className="rounded-16 border border-border bg-surface p-6 text-center shadow-1 sm:p-8">
          <div className="mx-auto flex size-12 items-center justify-center rounded-16 bg-primary/10 text-primary">
            <BrainCircuit className="size-6" aria-hidden />
          </div>
          <h2 className="mt-4 text-title text-foreground">{t("memory.home.headline")}</h2>
          <p className="mx-auto mt-2 max-w-sm text-ui text-muted-foreground">
            {t("memory.home.description")}
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2 text-left">
            <MemoryCategory
              icon={<Fingerprint className="size-4" aria-hidden />}
              label={t("memory.home.categoryIdentity")}
            />
            <MemoryCategory
              icon={<Users className="size-4" aria-hidden />}
              label={t("memory.home.categoryRelationships")}
            />
            <MemoryCategory
              icon={<NotebookPen className="size-4" aria-hidden />}
              label={t("memory.home.categoryJournal")}
            />
            <MemoryCategory
              icon={<FolderOpen className="size-4" aria-hidden />}
              label={t("memory.home.categoryProjects")}
            />
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h3 className="text-section text-foreground">{t("memory.home.backupHeading")}</h3>
            <span className="text-aux text-muted-foreground">{t("memory.home.backupHint")}</span>
          </div>
          <SyncStatusPanel path={MEMORY_SYNC_KEY} />
          <p className="px-1 text-aux text-subtle-foreground">{t("memory.home.deviceNote")}</p>
        </section>
      </div>
    </div>
  );
}

export default function MemoryPage() {
  const { t } = useTranslation("files");
  return (
    <FileBrowserPage
      apiBasePath="/api/memory"
      autoSave={getMemoryAutoSavePolicy}
      folderPanel={() => <MemoryFolderPanel />}
      initialSelectedFolderPath="memory"
      logicalRootPath="memory"
      rootLabel={t("memory.rootLabel")}
      searchPlaceholder={t("memory.searchPlaceholder")}
      selectInitialFolderOnMobile={false}
      sidebarHeading={t("memory.sidebarHeading")}
      title={t("memory.title")}
    />
  );
}
