import { ExternalLink, X } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { FileBrowserPage } from "@/components/file-browser-page";
import { useResolvedSelection } from "@/components/file-browser/hooks/useResolvedSelection";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { getMemoryAutoSavePolicy } from "@/lib/memory-autosave";

const MEMORY_ROOT = "memory";

/**
 * A memory file or folder a chat message links, opened in a sheet beside the
 * chat so the chat stays where it was. `path` is its logical path, such as
 * `memory/topics/rome-ui.md`, or null while the sheet is closed. `href` is
 * the link itself, which the sheet's header opens as the full Memory page.
 * Edits save as on the Memory page, and closing settles any left unsaved.
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
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const close = () => {
    const guard = leaveGuard.current;
    if (!guard) return onClose();
    void guard().then((canLeave) => {
      if (canLeave) onClose();
    });
  };
  return (
    // The sheet is drawn in a portal, but React still passes its clicks up to
    // the message the link sits in, where a tap opens the message's menu.
    <span className="contents" onClick={(event) => event.stopPropagation()}>
      <Sheet
        open={path !== null}
        onClose={close}
        ariaLabel={tFiles("memory.title")}
        widthClassName="w-full max-w-3xl"
      >
        {/* Its height is the row's, with the status bar's inset on top. */}
        <div className="box-content flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
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
          <IconButton size="sm" label={t("memoryFile.close")} icon={<X />} onClick={close} />
        </div>
        <div className="min-h-0 flex-1">
          {/* Mounted once the link resolves, so the root never flashes first. A
              path that is not there lands on the root. */}
          {path !== null && settled && (
            <FileBrowserPage
              apiBasePath="/api/memory"
              autoSave={getMemoryAutoSavePolicy}
              embedded
              externalSelection={selection ?? { path: MEMORY_ROOT, type: "directory" }}
              leaveGuard={leaveGuard}
              logicalRootPath={MEMORY_ROOT}
              rootLabel={tFiles("memory.rootLabel")}
              searchPlaceholder={tFiles("memory.searchPlaceholder")}
              sidebarHeading={tFiles("memory.sidebarHeading")}
            />
          )}
        </div>
      </Sheet>
    </span>
  );
}
