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

  const totalBytes = uploads.reduce((total, upload) => total + upload.file.size, 0);
  let bytesBefore = 0;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {uploads.map((upload, index) => {
        // FormData sends file parts in append order. Translate the request's
        // byte progress into each file's portion so completed files reach 100%
        // before the next file starts. Multipart headers are small and are
        // deliberately excluded from the estimate.
        const progress =
          uploadProgress === undefined ||
          uploadProgress === null ||
          totalBytes === 0 ||
          upload.file.size === 0
            ? uploadProgress
            : Math.max(
                0,
                Math.min(1, (uploadProgress * totalBytes - bytesBefore) / upload.file.size),
              );
        bytesBefore += upload.file.size;
        const percentage = progress == null ? null : Math.round(progress * 100);

        return (
          <ComposerChip
            key={upload.id}
            prefix={t("composer.filePill", { index: index + 1 })}
            title={upload.file.name}
            onRemove={disabled ? undefined : () => onRemove(upload.id)}
            removeLabel={t("composer.removeFile", { name: upload.file.name })}
            className={uploadProgress !== undefined ? "relative overflow-hidden" : undefined}
          >
            {upload.file.name}
            {uploadProgress !== undefined && (
              <>
                {percentage !== null && (
                  <span aria-hidden="true" className="ml-1 tabular-nums text-muted-foreground">
                    {percentage}%
                  </span>
                )}
                <span
                  role="progressbar"
                  aria-label={t("composer.uploadProgress", { name: upload.file.name })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percentage ?? undefined}
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-muted"
                >
                  <span
                    className={
                      progress === null
                        ? "block h-full w-full animate-pulse bg-primary"
                        : "block h-full bg-primary transition-[width]"
                    }
                    style={progress === null ? undefined : { width: `${percentage}%` }}
                  />
                </span>
              </>
            )}
          </ComposerChip>
        );
      })}
    </div>
  );
}
