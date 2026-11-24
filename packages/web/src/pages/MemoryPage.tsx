import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  BrainCircuit,
  ChevronRight,
  Fingerprint,
  FolderOpen,
  NotebookPen,
  Users,
} from "lucide-react";
import { FileBrowserPage } from "@/components/file-browser-page";
import { SyncStatusPanel } from "@/components/sync/SyncStatusPanel";
import { getMemoryAutoSavePolicy } from "@/lib/memory-autosave";

/** Reserved sync key for the memory dir — mirrors `MEMORY_SYNC_KEY` in the
 * backend sync routes. Memory rides the same sync stack as projects. */
const MEMORY_SYNC_KEY = "@memory";

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
export function MemoryFolderPanel() {
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

        {/* Dream rewrites memory, apps and skills while the guardian is away.
            Its page is off the launcher, so this is where they find what it
            changed. */}
        <section className="flex flex-col gap-2">
          <h3 className="px-4 text-aux text-muted-foreground">{t("memory.home.dreamHeading")}</h3>
          <Link
            to="/apps/dream"
            className="flex flex-col gap-2 rounded-12 border border-border bg-surface px-4 py-3 text-ui transition-colors hover:bg-accent sm:flex-row sm:items-center sm:justify-between sm:gap-3"
          >
            <span className="min-w-0 text-muted-foreground">
              {t("memory.home.dreamDescription")}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-primary">
              {t("memory.home.dreamLink")}
              <ChevronRight className="size-4" aria-hidden />
            </span>
          </Link>
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="px-4 text-aux text-muted-foreground">{t("memory.home.backupHeading")}</h3>
          <SyncStatusPanel path={MEMORY_SYNC_KEY} />
          <div className="flex flex-col gap-1 px-4 text-aux [text-wrap-style:pretty] text-muted-foreground">
            <p>{t("memory.home.backupHint")}</p>
            <p>{t("memory.home.deviceNote")}</p>
          </div>
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
      sidebarHeading={t("memory.sidebarHeading")}
    />
  );
}
