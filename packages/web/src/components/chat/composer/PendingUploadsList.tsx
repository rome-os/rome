import { useEffect, useState, type ReactNode } from "react";
import {
  FileArchive,
  FileAudio,
  FileCode,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  X,
  ZoomIn,
} from "lucide-react";
import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";
import "./pending-image-preview.css";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import type { PendingUpload } from "@/lib/chat-types";
import { UploadRing } from "./ComposerChip";
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

function getFileCategory(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf") {
    return {
      Icon: FileText,
      label: "PDF",
      badgeClass: "pending-badge-pdf",
      isCode: false,
    };
  }

  if (
    [
      "ts",
      "tsx",
      "js",
      "jsx",
      "py",
      "rs",
      "go",
      "java",
      "c",
      "cpp",
      "h",
      "hpp",
      "cs",
      "rb",
      "php",
      "swift",
      "kt",
      "scala",
      "sh",
      "sql",
      "html",
      "css",
      "scss",
      "less",
    ].includes(ext)
  ) {
    return {
      Icon: FileCode,
      label: ext.toUpperCase().slice(0, 4),
      badgeClass: "pending-badge-code",
      isCode: true,
    };
  }

  if (["json", "yaml", "yml", "toml", "xml"].includes(ext)) {
    return {
      Icon: FileJson,
      label: ext.toUpperCase().slice(0, 4),
      badgeClass: "pending-badge-json",
      isCode: true,
    };
  }

  if (["csv", "tsv", "xlsx", "xls"].includes(ext)) {
    return {
      Icon: FileSpreadsheet,
      label: ext === "csv" || ext === "tsv" ? ext.toUpperCase() : "XLS",
      badgeClass: "pending-badge-sheet",
      isCode: false,
    };
  }

  if (["zip", "tar", "gz", "tgz", "7z", "rar", "bz2"].includes(ext)) {
    return {
      Icon: FileArchive,
      label: "ZIP",
      badgeClass: "pending-badge-archive",
      isCode: false,
    };
  }

  if (["mp3", "wav", "flac", "m4a", "ogg", "aac"].includes(ext)) {
    return {
      Icon: FileAudio,
      label: "AUDIO",
      badgeClass: "pending-badge-audio",
      isCode: false,
    };
  }

  if (["mp4", "mov", "mkv", "webm", "avi", "m4v"].includes(ext)) {
    return {
      Icon: FileVideo,
      label: "VIDEO",
      badgeClass: "pending-badge-video",
      isCode: false,
    };
  }

  return {
    Icon: FileText,
    label: ext ? ext.toUpperCase().slice(0, 4) : "DOC",
    badgeClass: "pending-badge-doc",
    isCode: false,
  };
}

function PendingDocumentPreview({
  file,
  prefix,
  onRemove,
  progress,
}: {
  file: File;
  prefix?: ReactNode;
  onRemove?: () => void;
  progress?: number | null;
}) {
  const { t } = useTranslation("chat");
  const [snippet, setSnippet] = useState<string>("");

  useEffect(() => {
    const isTextLike =
      file.type.startsWith("text/") ||
      file.type === "application/json" ||
      file.type === "application/javascript" ||
      file.type === "application/xml" ||
      /\.(txt|md|mdx|json|ts|tsx|js|jsx|py|rs|go|html|css|scss|yaml|yml|toml|sql|sh|csv|tsv|log)$/i.test(
        file.name,
      );

    if (!isTextLike) return;

    let cancelled = false;
    try {
      const slice = typeof file.slice === "function" ? file.slice(0, 1024) : file;
      if (typeof slice.text === "function") {
        slice
          .text()
          .then((text) => {
            if (!cancelled) setSnippet(text.trim());
          })
          .catch(() => {});
      }
    } catch {
      // slice or text not available
    }

    return () => {
      cancelled = true;
    };
  }, [file]);

  const meta = getFileCategory(file.name);
  const firstLineHeading = snippet.startsWith("#");

  return (
    <div
      className="pending-doc-card relative size-24 shrink-0 flex flex-col overflow-hidden rounded-8 border shadow-xs select-none"
      title={typeof prefix === "string" ? `${prefix} ${file.name}` : file.name}
    >
      {/* Document content preview */}
      <div className="pending-doc-paper relative flex-1 overflow-hidden">
        {snippet ? (
          <div
            className={`pointer-events-none line-clamp-6 p-2 ${
              meta.isCode ? "pending-doc-sheet-code" : "pending-doc-sheet"
            }`}
          >
            {firstLineHeading ? (
              <span className="pending-doc-heading block">{snippet.split("\n")[0]}</span>
            ) : null}
            <span className={meta.isCode ? "pending-doc-code" : "pending-doc-body"}>
              {firstLineHeading ? snippet.split("\n").slice(1).join("\n") : snippet}
            </span>
          </div>
        ) : (
          /* Simulated document sheet layout for non-text / binary files */
          <div className="flex h-full flex-col justify-between p-2">
            <div className="flex flex-col gap-1 opacity-40">
              <div className="pending-doc-skeleton-bar-dark h-1 w-3/4 rounded-full" />
              <div className="pending-doc-skeleton-bar h-1 w-full rounded-full" />
            </div>
            <div className="my-auto flex flex-col items-center justify-center gap-1">
              <span
                className={`flex size-7 items-center justify-center rounded-6 shadow-xs ${meta.badgeClass}`}
              >
                <meta.Icon className="size-4 stroke-[2]" aria-hidden="true" />
              </span>
              <span className="pending-doc-badge-label uppercase text-muted-foreground">
                {meta.label}
              </span>
            </div>
            <div className="flex flex-col gap-1 opacity-30">
              <div className="pending-doc-skeleton-bar h-1 w-5/6 rounded-full" />
              <div className="pending-doc-skeleton-bar h-1 w-2/3 rounded-full" />
            </div>
          </div>
        )}
      </div>

      {/* Attachment footer */}
      <div className="pending-doc-footer flex h-7 shrink-0 items-center px-2">
        {prefix ? <span className="sr-only">{prefix}</span> : null}
        <span
          className={`flex size-4.5 shrink-0 items-center justify-center rounded-4 ${meta.badgeClass}`}
        >
          <meta.Icon className="size-3 stroke-[2]" aria-hidden="true" />
        </span>
        <span className="pending-doc-filename truncate" title={file.name}>
          {file.name}
        </span>
      </div>
      {/* Top-right action: progress ring or remove button */}
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
function PendingImagePreview({
  file,
  prefix,
  onRemove,
  progress,
}: {
  file: File;
  prefix?: ReactNode;
  onRemove?: () => void;
  progress?: number | null;
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

  if (failed || !src) {
    return (
      <PendingDocumentPreview file={file} prefix={prefix} onRemove={onRemove} progress={progress} />
    );
  }

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
          const prefix = t("composer.filePill", { index: index + 1 });
          return upload.file.type.startsWith("image/") ? (
            <PendingImagePreview
              key={upload.id}
              file={upload.file}
              prefix={prefix}
              onRemove={remove}
              progress={progress}
            />
          ) : (
            <PendingDocumentPreview
              key={upload.id}
              file={upload.file}
              prefix={prefix}
              onRemove={remove}
              progress={progress}
            />
          );
        })}
      </div>
    </div>
  );
}
