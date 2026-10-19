import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Upload } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useFileBrowserStore } from "./store/context";
import type { FileUploadProgress } from "./store/types";

function formatBytes(bytes: number, language: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(
    Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)),
    units.length - 1,
  );
  return `${new Intl.NumberFormat(language, {
    minimumFractionDigits: unit === 0 ? 0 : 1,
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(bytes / 1024 ** unit)} ${units[unit]}`;
}

export function UploadProgress({ progress }: { progress: FileUploadProgress }) {
  const { t, i18n } = useTranslation("files");
  const titleId = useId();
  const warningId = useId();
  const determinate = progress.total > 0;
  const finishing = progress.phase === "finishing";
  const percentage = determinate
    ? Math.min(100, Math.floor((progress.loaded / progress.total) * 100))
    : undefined;
  const title =
    progress.fileCount === 1
      ? progress.firstFileName
      : t("status.uploadingFiles", { count: progress.fileCount });
  const label =
    progress.fileCount === 1 ? t("status.uploadingFile", { name: progress.firstFileName }) : title;

  return (
    <Card
      role="status"
      aria-live="polite"
      aria-labelledby={titleId}
      aria-describedby={warningId}
      className="min-w-0 gap-3 border-primary/25 bg-surface p-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-8 bg-primary/10 text-primary">
          <Upload size={16} aria-hidden="true" className="motion-safe:animate-pulse" />
        </div>
        <span id={titleId} className="min-w-0 flex-1 truncate text-section" title={title}>
          {title}
        </span>
        {/* Numbers tick constantly; keep them out of the live region (the progressbar exposes them). */}
        <span
          aria-hidden={finishing ? undefined : true}
          className="shrink-0 text-aux tabular-nums text-foreground"
        >
          {finishing
            ? t("status.uploadFinishing")
            : percentage !== undefined
              ? `${percentage}%`
              : null}
        </span>
      </div>
      <div className="space-y-2">
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          aria-valuetext={finishing ? t("status.uploadFinishing") : undefined}
          className="h-1.5 overflow-hidden rounded-full bg-primary/10"
        >
          <div
            className={`h-full rounded-full bg-primary motion-reduce:transition-none ${
              determinate
                ? "transition-[width] duration-300 ease-out"
                : "w-1/3 motion-safe:animate-pulse"
            }`}
            style={determinate ? { width: `${percentage}%` } : undefined}
          />
        </div>
        {determinate && (
          <p aria-hidden="true" className="text-aux tabular-nums text-muted-foreground">
            {t("status.uploadBytes", {
              loaded: formatBytes(Math.min(progress.loaded, progress.total), i18n.language),
              total: formatBytes(progress.total, i18n.language),
            })}
          </p>
        )}
      </div>
      <div className="flex items-start gap-2 border-t border-border-subtle pt-3 text-foreground">
        <AlertTriangle size={14} aria-hidden="true" className="mt-1 shrink-0 text-warning-fg" />
        <p id={warningId} className="text-ui">
          {t("status.uploadKeepOpen")}
        </p>
      </div>
    </Card>
  );
}

/**
 * Reads progress from the store so only the card re-renders on each XHR tick;
 * parents subscribe to `uploadProgress !== null` instead of the object.
 */
export function UploadProgressFromStore() {
  const progress = useFileBrowserStore((s) => s.ui.uploadProgress);
  return progress ? <UploadProgress progress={progress} /> : null;
}
