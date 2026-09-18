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
 * Split the fraction of attachment bytes sent into one fraction per file.
 *
 * `postSessionTurn` measures progress over the files alone, which it writes
 * last and in order, so the files occupy known, ordered byte ranges of that
 * total. Mapping the fraction onto those ranges is therefore a real per-file
 * reading, not a guess: the first file fills, then the second.
 *
 * Part headers and boundaries are ignored. They are a fixed couple of hundred
 * bytes per file against attachment-sized payloads, so the only visible effect
 * is each ring completing a hair early.
 */
function splitProgressByFile(uploads: PendingUpload[], overall: number): number[] {
  const sizes = uploads.map((upload) => upload.file.size);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  // Zero-byte files carry no bytes to attribute, so weight them evenly instead
  // of dividing by zero.
  if (total === 0) return sizes.map(() => overall);

  const transferred = overall * total;
  let consumed = 0;
  return sizes.map((size) => {
    const start = consumed;
    consumed += size;
    if (size === 0) return transferred >= start ? 1 : 0;
    return Math.max(0, Math.min(1, (transferred - start) / size));
  });
}

/**
 * Pending attachments, rendered in the same chip language as the pre-send tray.
 * They share a surface, so a second pill geometry here read as two systems —
 * `ComposerChip` owns height, radius, padding and text size for both.
 *
 * Upload progress rides inside the chips as a ring per file, taking the remove
 * button's slot. A separate progress row would be easier, but it appears and
 * disappears under the tray and shoves the composer around on every send.
 */
export function PendingUploadsList({
  uploads,
  onRemove,
  disabled,
  uploadProgress,
}: PendingUploadsListProps) {
  const { t } = useTranslation("chat");
  if (uploads.length === 0) return null;

  const uploading = uploadProgress !== undefined;
  const perFile =
    uploading && uploadProgress !== null ? splitProgressByFile(uploads, uploadProgress) : null;

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
            progress={uploading ? (perFile ? perFile[index] : null) : undefined}
            progressLabel={t("composer.uploadProgressFor", { name: upload.file.name })}
          >
            {upload.file.name}
          </ComposerChip>
        ))}
      </div>
    </div>
  );
}
