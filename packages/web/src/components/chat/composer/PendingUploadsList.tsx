import { useTranslation } from "react-i18next";
import type { PendingUpload } from "@/lib/chat-types";
import { ComposerChip } from "./ComposerChip";

export interface PendingUploadsListProps {
  uploads: PendingUpload[];
  onRemove: (id: string) => void;
  disabled: boolean;
  /** Undefined when idle, null for indeterminate, otherwise a 0–1 fraction. */
  uploadProgress?: number | null;
}

/**
 * Pending attachments, rendered in the same chip language as the pre-send tray.
 * They share a surface, so a second pill geometry here read as two systems —
 * `ComposerChip` owns height, radius, padding and text size for both.
 */
export function PendingUploadsList({
  uploads,
  onRemove,
  disabled,
  uploadProgress,
}: PendingUploadsListProps) {
  const { t } = useTranslation("chat");
  if (uploads.length === 0) return null;

  const percentage =
    uploadProgress === undefined || uploadProgress === null
      ? null
      : Math.round(uploadProgress * 100);
  return (
    <div className="mb-3">
      <div className="flex flex-wrap gap-2">
        {uploads.map((upload, index) => (
          <ComposerChip
            key={upload.id}
            prefix={t("composer.filePill", { index: index + 1 })}
            title={upload.file.name}
            onRemove={disabled ? undefined : () => onRemove(upload.id)}
            removeLabel={t("composer.removeFile", { name: upload.file.name })}
          >
            {upload.file.name}
          </ComposerChip>
        ))}
      </div>
      {uploadProgress !== undefined && (
        <div className="mt-2 flex items-center gap-2 text-aux text-muted-foreground">
          <span>{t("composer.uploadingFiles")}</span>
          <span
            role="progressbar"
            aria-label={t("composer.uploadProgress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percentage ?? undefined}
            className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-muted"
          >
            <span
              className={
                uploadProgress === null
                  ? "block h-full w-full animate-pulse bg-primary"
                  : "block h-full bg-primary transition-[width]"
              }
              style={uploadProgress === null ? undefined : { width: `${percentage}%` }}
            />
          </span>
          {percentage !== null && <span className="tabular-nums">{percentage}%</span>}
        </div>
      )}
    </div>
  );
}
