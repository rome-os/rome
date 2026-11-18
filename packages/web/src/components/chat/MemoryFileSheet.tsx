import { ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { FileBrowserPage } from "@/components/file-browser-page";
import { useResolvedSelection } from "@/components/file-browser/hooks/useResolvedSelection";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";

const MEMORY_ROOT = "memory";

/**
 * A memory file or folder a chat message links, opened in a sheet beside the
 * chat so the chat stays where it was. `path` is its logical path, such as
 * `memory/topics/rome-ui.md`, or null while the sheet is closed. `href` is
 * the link itself, which the sheet's header opens as the full Memory page.
 */
export function MemoryFileSheet({
  path,
  href,
  onClose,
}: {
  path: string | null;
  href: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tFiles } = useTranslation("files");
  const { selection, settled } = useResolvedSelection("/api/memory", path);
  return (
    <Sheet
      open={path !== null}
      onClose={onClose}
      ariaLabel={tFiles("memory.title")}
      widthClassName="w-full max-w-3xl"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
        <SheetTitle className="flex-1 truncate text-title text-foreground">
          {tFiles("memory.title")}
        </SheetTitle>
        <Link
          to={href}
          onClick={onClose}
          className="flex shrink-0 items-center gap-1 text-ui text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-4" aria-hidden />
          {t("memoryFile.openPage")}
        </Link>
        <IconButton size="sm" label={t("memoryFile.close")} icon={<X />} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1">
        {/* Mounted once the link resolves, so the root never flashes first. A
            path that is not there lands on the root. */}
        {path !== null && settled && (
          <FileBrowserPage
            apiBasePath="/api/memory"
            embedded
            externalSelection={selection ?? { path: MEMORY_ROOT, type: "directory" }}
            logicalRootPath={MEMORY_ROOT}
            rootLabel={tFiles("memory.rootLabel")}
            searchPlaceholder={tFiles("memory.searchPlaceholder")}
            sidebarHeading={tFiles("memory.sidebarHeading")}
          />
        )}
      </div>
    </Sheet>
  );
}
