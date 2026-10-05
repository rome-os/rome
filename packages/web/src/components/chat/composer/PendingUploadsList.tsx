import { useEffect, useState, type ReactNode } from "react";
import { X, ZoomIn } from "lucide-react";
import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";
import "./pending-image-preview.css";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import type { PendingUpload } from "@/lib/chat-types";
import { ComposerChip, UploadRing } from "./ComposerChip";
import { ImagePreviewContent } from "./ImagePreviewContent";

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

function PendingImagePreview({
  file,
  onRemove,
  progress,
  fallback,
}: {
  file: File;
  onRemove?: () => void;
  progress?: number | null;
  fallback: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if (failed || !src) return fallback;

  return (
    <div className="relative size-24 shrink-0 [&_[data-rmiz-btn-zoom]]:left-2 [&_[data-rmiz-btn-zoom]]:right-auto">
      <Zoom
        a11yNameButtonZoom={t("composer.previewImage")}
        a11yNameButtonUnzoom={t("composer.closeImagePreview")}
        classDialog="pending-image-preview"
        IconZoom={ZoomIn}
        IconUnzoom={X}
        ZoomContent={ImagePreviewContent}
        canSwipeToUnzoom={false}
        zoomMargin={64}
      >
        <img
          src={src}
          alt={file.name}
          className="visible size-24 rounded-8 border border-border bg-surface object-cover"
          onError={() => setFailed(true)}
        />
      </Zoom>
      {progress !== undefined ? (
        <span className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-surface text-foreground shadow-sm">
          <UploadRing
            progress={progress}
            label={t("composer.uploadProgressFor", { name: file.name })}
          />
        </span>
      ) : onRemove ? (
        <IconButton
          data-pending-image-remove
          size="xs"
          onClick={onRemove}
          label={t("composer.removeFile", { name: file.name })}
          icon={<X className="size-3" strokeWidth={2.5} />}
          className="absolute right-1 top-1 rounded-full bg-surface shadow-sm"
        />
      ) : null}
    </div>
  );
}

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
    <div className="mb-3 min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="flex w-max min-w-full items-start gap-2 p-1">
        {uploads.map((upload, index) => {
          const progress = uploading ? (perFile ? perFile[index] : null) : undefined;
          const remove = disabled || uploading ? undefined : () => onRemove(upload.id);
          const chip = (
            <ComposerChip
              key={upload.id}
              prefix={t("composer.filePill", { index: index + 1 })}
              title={upload.file.name}
              onRemove={remove}
              removeLabel={t("composer.removeFile", { name: upload.file.name })}
              progress={progress}
              progressLabel={t("composer.uploadProgressFor", { name: upload.file.name })}
            >
              {upload.file.name}
            </ComposerChip>
          );
          return upload.file.type.startsWith("image/") ? (
            <PendingImagePreview
              key={upload.id}
              file={upload.file}
              onRemove={remove}
              progress={progress}
              fallback={chip}
            />
          ) : (
            chip
          );
        })}
      </div>
    </div>
  );
}
