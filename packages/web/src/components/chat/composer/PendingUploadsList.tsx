import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  File as FileGlyph,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Play,
  X,
  type LucideIcon,
} from "lucide-react";
import Zoom from "react-medium-image-zoom";
import "react-medium-image-zoom/dist/styles.css";
import "./pending-image-preview.css";
import { useTranslation } from "react-i18next";
import type { PendingUpload } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { UploadRing } from "./ComposerChip";
import { ImagePreviewContent, type PreviewContentProps } from "./ImagePreviewContent";
import { VideoPreviewContent } from "./VideoPreviewContent";
import { captureVideoPoster } from "./video-poster";

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

type FileKind =
  | "code"
  | "data"
  | "table"
  | "text"
  | "pdf"
  | "sheet"
  | "archive"
  | "audio"
  | "video"
  | "image"
  | "other";

// `text` decides whether the card reads a snippet, and `mono` sets it in the
// code stack. Both hang off the kind so the glyph and the preview never disagree
// about what a file is.
const KINDS: Record<FileKind, { Icon: LucideIcon; text: boolean; mono: boolean }> = {
  code: { Icon: FileCode, text: true, mono: true },
  data: { Icon: FileJson, text: true, mono: true },
  table: { Icon: FileSpreadsheet, text: true, mono: true },
  text: { Icon: FileText, text: true, mono: false },
  pdf: { Icon: FileText, text: false, mono: false },
  sheet: { Icon: FileSpreadsheet, text: false, mono: false },
  archive: { Icon: FileArchive, text: false, mono: false },
  audio: { Icon: FileAudio, text: false, mono: false },
  video: { Icon: FileVideo, text: false, mono: false },
  image: { Icon: FileImage, text: false, mono: false },
  other: { Icon: FileGlyph, text: false, mono: false },
};

const EXTENSIONS: Partial<Record<FileKind, string>> = {
  code: "ts tsx js jsx mjs cjs py rs go java kt scala c h cpp hpp cs rb php swift sh sql html css scss less",
  data: "json jsonl yaml yml toml xml ini env",
  table: "csv tsv",
  text: "txt md mdx log rst",
  pdf: "pdf",
  sheet: "xlsx xls ods numbers",
  archive: "zip tar gz tgz bz2 xz 7z rar",
  audio: "mp3 wav flac m4a ogg aac",
  video: "mp4 mov mkv webm avi m4v",
  image: "png jpg jpeg gif webp svg heic heif avif bmp tiff",
};

const KIND_BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.split(" ").map((extension) => [extension, kind as FileKind] as const),
  ),
);

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-sh|x-yaml|toml)\b)/;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function fileKind(file: File): FileKind {
  const byExtension = KIND_BY_EXTENSION.get(extensionOf(file.name));
  if (byExtension) return byExtension;
  const type = file.type;
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (TEXT_MIME.test(type)) return "text";
  return "other";
}

const SNIPPET_BYTES = 1024;

/** The first kilobyte of a text file, or "" until it is read or when it reads as binary. */
function useTextSnippet(file: File, enabled: boolean): string {
  const [snippet, setSnippet] = useState<{ file: File; text: string } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    file
      .slice(0, SNIPPET_BYTES)
      .text()
      .then(
        (text) => {
          // An extension can name two formats (`.ts` is also MPEG transport
          // stream), and a NUL byte never appears in text.
          if (live) setSnippet({ file, text: text.includes("\u0000") ? "" : text.trimEnd() });
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [file, enabled]);

  return snippet?.file === file ? snippet.text : "";
}

interface CardProps {
  file: File;
  /** The send-order label the agent sees, such as "#File 2". */
  label: string;
  index: number;
  onRemove?: () => void;
  progress?: number | null;
}

/**
 * The card chrome both kinds share: a 96px tile, its send-order number, and
 * the top-right action. The action slot holds either the remove button or the
 * upload ring, never both, which is what keeps a file from being removed while
 * its bytes are in flight.
 */
function PendingCard({
  file,
  label,
  index,
  onRemove,
  progress,
  children,
}: CardProps & { children: ReactNode }) {
  const { t } = useTranslation("chat");
  // The action floats over a thumbnail, so it carries its own surface and a
  // hairline rather than a shadow. Its visible box stays 24px to leave the
  // thumbnail visible, and the hit area reaches 6px past it, under half the
  // tray's 8px gap.
  const slot =
    "absolute right-1 top-1 flex size-6 items-center justify-center rounded-full border border-border bg-surface text-foreground";

  return (
    <li className="relative size-24 shrink-0" title={`${label} · ${file.name}`}>
      <span className="sr-only">{label}</span>
      {children}
      <span
        data-pending-card-overlay
        aria-hidden
        className="pointer-events-none absolute left-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full border border-border bg-surface px-1 text-badge text-foreground tabular-nums"
      >
        {index}
      </span>
      {progress !== undefined ? (
        <span data-pending-card-overlay className={slot}>
          <UploadRing
            progress={progress}
            label={t("composer.uploadProgressFor", { name: file.name })}
            className="m-0"
          />
        </span>
      ) : onRemove ? (
        <button
          type="button"
          data-pending-card-overlay
          onClick={onRemove}
          aria-label={t("composer.removeFile", { name: file.name })}
          title={t("composer.removeFile", { name: file.name })}
          className={cn(
            slot,
            "outline-1 outline-offset-0 outline-transparent transition-colors after:absolute after:-inset-1.5 hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50",
          )}
        >
          <X className="size-3" strokeWidth={2.5} aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function PendingDocumentPreview(props: CardProps) {
  const { file } = props;
  const kind = KINDS[fileKind(file)];
  const snippet = useTextSnippet(file, kind.text);
  const extension = extensionOf(file.name);

  return (
    <PendingCard {...props}>
      <div className="flex size-24 flex-col overflow-hidden rounded-8 border border-border bg-surface select-none">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-surface-muted">
          {snippet ? (
            <div
              aria-hidden
              data-pending-doc-page
              className={cn(
                // The top inset clears the number and the action, which sit
                // over this band, so the file's first line stays visible.
                "pending-doc-page absolute left-0 top-0 overflow-hidden whitespace-pre-wrap break-words px-5 pt-16 pb-5 text-aux text-muted-foreground",
                kind.mono && "font-mono",
              )}
            >
              {snippet}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-muted-foreground">
              <kind.Icon className="size-6" strokeWidth={1.5} aria-hidden />
              {extension ? (
                <span className="max-w-full truncate px-2 text-badge uppercase" aria-hidden>
                  {extension}
                </span>
              ) : null}
            </div>
          )}
        </div>
        <span className="truncate border-t border-border px-2 py-1 text-aux text-foreground">
          {file.name}
        </span>
      </div>
    </PendingCard>
  );
}

// The zoom button covers the whole card when focused, so the focus edge is the
// card's own outline and no glyph is needed.
const NoGlyph = () => null;

function PendingImagePreview(props: CardProps) {
  const { file } = props;
  const { t } = useTranslation("chat");
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    setFailed(false);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Browsers that cannot decode a format (HEIC on most desktops) fire onError,
  // and an empty frame would hide which file is attached.
  if (failed || !src) return <PendingDocumentPreview {...props} />;

  return (
    <PendingCard {...props}>
      <div className="pending-image-card size-24">
        <Zoom
          a11yNameButtonZoom={t("composer.previewImage")}
          a11yNameButtonUnzoom={t("composer.closeImagePreview")}
          classDialog="pending-image-preview"
          IconZoom={NoGlyph}
          IconUnzoom={X}
          ZoomContent={ImagePreviewContent}
          canSwipeToUnzoom={false}
          zoomMargin={64}
        >
          <img
            src={src}
            alt={file.name}
            className="visible size-24 rounded-8 border border-border bg-surface-muted object-cover"
            onError={() => setFailed(true)}
          />
        </Zoom>
      </div>
    </PendingCard>
  );
}

interface VideoPreview {
  file: File;
  /** The file itself, which the viewer plays. */
  src: string;
  poster: string;
  duration: number | null;
}

/**
 * The file's playable URL and its poster, or undefined until the poster is
 * captured, which never happens for a video the browser cannot decode.
 */
function useVideoPreview(file: File): VideoPreview | undefined {
  const [preview, setPreview] = useState<VideoPreview>();

  useEffect(() => {
    const src = URL.createObjectURL(file);
    const controller = new AbortController();
    let poster: string | undefined;
    captureVideoPoster(src, controller.signal).then(
      (frame) => {
        if (controller.signal.aborted) return;
        poster = URL.createObjectURL(frame.blob);
        setPreview({ file, src, poster, duration: frame.duration });
      },
      () => {},
    );
    return () => {
      controller.abort();
      URL.revokeObjectURL(src);
      if (poster) URL.revokeObjectURL(poster);
    };
  }, [file]);

  return preview?.file === file ? preview : undefined;
}

/** 42 → "0:42", 3725 → "1:02:05". */
function formatDuration(seconds: number): string {
  // A clip under half a second still has a length worth showing.
  const total = Math.max(1, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function PendingVideoPreview(props: CardProps) {
  const { file } = props;
  const { t } = useTranslation("chat");
  const preview = useVideoPreview(file);
  const [failed, setFailed] = useState(false);
  const src = preview?.src;
  const ZoomContent = useMemo(
    () =>
      src
        ? (content: PreviewContentProps) => <VideoPreviewContent {...content} src={src} />
        : undefined,
    [src],
  );

  // Until the poster lands, and for a video the browser cannot decode, the
  // file card stands in. Its glyph already says video, so the swap to the
  // frame reads as the preview arriving rather than the card changing kind.
  if (!preview || failed) return <PendingDocumentPreview {...props} />;

  return (
    <PendingCard {...props}>
      <div className="pending-image-card size-24">
        <Zoom
          a11yNameButtonZoom={t("composer.playVideo")}
          a11yNameButtonUnzoom={t("composer.closeImagePreview")}
          classDialog="pending-image-preview"
          IconZoom={NoGlyph}
          IconUnzoom={X}
          ZoomContent={ZoomContent}
          canSwipeToUnzoom={false}
          zoomMargin={64}
        >
          <img
            src={preview.poster}
            alt={file.name}
            className="visible size-24 rounded-8 border border-border bg-surface-muted object-cover"
            onError={() => setFailed(true)}
          />
        </Zoom>
      </div>
      <span
        data-pending-card-overlay
        aria-hidden
        className="pointer-events-none absolute inset-0 m-auto flex size-8 items-center justify-center rounded-full border border-border bg-surface text-foreground"
      >
        <Play className="size-3.5 translate-x-px fill-current" strokeWidth={2.5} />
      </span>
      {preview.duration ? (
        <span
          data-pending-card-overlay
          aria-hidden
          className="pointer-events-none absolute bottom-1 right-1 flex h-5 items-center rounded-full border border-border bg-surface px-1.5 text-badge text-foreground tabular-nums"
        >
          {formatDuration(preview.duration)}
        </span>
      ) : null}
    </PendingCard>
  );
}

/**
 * Pending attachments as one row of 96px cards. An image shows its pixels and
 * opens a full-size viewer. A video shows a frame with its length and plays in
 * the same viewer. Any other file shows a scaled render of its first lines when
 * it is text, or its kind's glyph when it is not.
 *
 * Each card carries its send-order number because the turn lists attachments
 * to the agent as "File N", so the guardian can point at "file 2" in the draft.
 * Upload progress rides on the cards, taking the remove button's slot, so the
 * tray does not reflow when a send starts.
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
    <div className="mb-3 min-w-0 max-w-full overflow-x-auto overscroll-x-contain [scrollbar-width:thin]">
      <ul className="flex w-max min-w-full items-start gap-2 p-1">
        {uploads.map((upload, index) => {
          const props: CardProps = {
            file: upload.file,
            label: t("composer.filePill", { index: index + 1 }),
            index: index + 1,
            onRemove: disabled || uploading ? undefined : () => onRemove(upload.id),
            progress: uploading ? (perFile ? perFile[index] : null) : undefined,
          };
          if (upload.file.type.startsWith("image/")) {
            return <PendingImagePreview key={upload.id} {...props} />;
          }
          if (fileKind(upload.file) === "video")
            return <PendingVideoPreview key={upload.id} {...props} />;
          return <PendingDocumentPreview key={upload.id} {...props} />;
        })}
      </ul>
    </div>
  );
}
