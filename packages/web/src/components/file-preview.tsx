// One preview for a file, by the kind the server gives it (`describeFile`):
// the projects viewer and a chat's Outputs tab both draw files with it.
// docs/domains/chats.md#outputs

import type { FileKind } from "@rome/api-types/file-kinds";
import { type ReactNode, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "@/components/markdown";
import { PreviewNeedsReload } from "@/components/file-browser/PreviewNeedsReload";
import {
  getDelimitedSeparator,
  getTextPreviewKind,
  isSpreadsheetPath,
  parseDelimitedContent,
} from "@/lib/file-preview";
import { lazyInPlace } from "@/lib/lazy-with-reload";

// The agent can open a file on its own, so a preview whose code is gone after
// an upgrade asks for a reload rather than reloading the page.
const lazyPreview = lazyInPlace(PreviewNeedsReload);

const DocxPreviewPane = lazyPreview(() =>
  import("@/components/docx-preview-pane").then((module) => ({
    default: module.DocxPreviewPane,
  })),
);

const SpreadsheetPreviewPane = lazyPreview(() =>
  import("@/components/spreadsheet-preview-pane").then((module) => ({
    default: module.SpreadsheetPreviewPane,
  })),
);

export interface PreviewedFile {
  kind: FileKind;
  /** Its path or name: the extension picks how text previews. */
  path: string;
  mimeType: string;
  /** Where its bytes are served, or null when they are not. */
  url: string | null;
  /** In bytes; null when unknown. */
  size: number | null;
}

export interface FilePreviewProps {
  file: PreviewedFile;
  /** Names the file to assistive tech. */
  title: string;
  /** A text file's text, as far as the host read it. */
  text: string;
  /**
   * For a text file: `preview` draws Markdown, a table or a page, and
   * `source` draws `source` instead. Other text always draws `source`.
   */
  textView: "preview" | "source";
  /** A text file's own view, such as an editor. */
  source: ReactNode;
  /**
   * An HTML file runs in a sandboxed frame with its scripts. Off, it draws
   * from its text with nothing in it running.
   */
  runPages: boolean;
  /** What a file with no preview shows. */
  fallback?: ReactNode;
}

/** Fills its parent's height; a host gives it one. */
export function FilePreview({
  file,
  title,
  text,
  textView,
  source,
  runPages,
  fallback,
}: FilePreviewProps) {
  const { t } = useTranslation("files");
  const textPreviewKind =
    file.kind === "text" && textView === "preview"
      ? getTextPreviewKind(file.path, file.mimeType)
      : null;
  const delimitedRows = useMemo(
    () =>
      textPreviewKind === "delimited"
        ? parseDelimitedContent(text, getDelimitedSeparator(file.path, file.mimeType))
        : [],
    [text, textPreviewKind, file.path, file.mimeType],
  );

  if (textPreviewKind === "markdown") {
    return (
      <div className="h-full overflow-auto bg-surface p-4 md:p-6">
        <Markdown className="text-foreground">{text}</Markdown>
      </div>
    );
  }

  if (textPreviewKind === "delimited") {
    return (
      <div className="h-full overflow-auto bg-surface p-4 md:p-6">
        {delimitedRows.length === 0 ? (
          <p className="text-ui text-muted-foreground">{t("view.noRowsToPreview")}</p>
        ) : (
          <table className="min-w-full border-collapse text-left text-ui">
            <tbody>
              {delimitedRows.map((row, rowIndex) => (
                <tr key={rowIndex} className={rowIndex === 0 ? "bg-surface-muted" : undefined}>
                  {row.map((cell, cellIndex) => {
                    const Cell = rowIndex === 0 ? "th" : "td";
                    return (
                      <Cell
                        key={cellIndex}
                        className="border border-border px-3 py-2 align-top text-foreground"
                      >
                        {cell}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (textPreviewKind === "html") {
    if (!runPages) {
      // No allow-* token: the page draws, and no script, form or plugin in it runs.
      return (
        <div className="h-full bg-surface-muted p-4">
          <iframe
            srcDoc={text}
            title={title}
            sandbox=""
            className="h-full w-full rounded-12 border border-border bg-white shadow-1"
          />
        </div>
      );
    }
    if (!file.url) {
      return (
        <div className="flex h-full items-center justify-center bg-surface p-6">
          <div className="max-w-md text-center">
            <h3 className="text-section text-foreground">{t("view.htmlPreviewFailedTitle")}</h3>
            <p className="mt-2 text-ui text-muted-foreground">
              {t("view.htmlPreviewFailedDescription")}
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="h-full bg-surface-muted p-4">
        <iframe
          src={file.url}
          title={title}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          className="h-full w-full rounded-12 border border-border bg-white shadow-1"
        />
      </div>
    );
  }

  if (file.kind === "text") return source;

  if (file.kind === "image" && file.url) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-surface-muted p-6">
        <img
          src={file.url}
          alt={title}
          className="max-h-full max-w-full rounded-12 border border-border bg-surface object-contain shadow-1"
        />
      </div>
    );
  }

  if (file.kind === "video" && file.url) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-surface-muted p-6">
        <video
          controls
          preload="metadata"
          className="max-h-full max-w-full rounded-12 bg-foreground shadow-1"
        >
          <source src={file.url} type={file.mimeType} />
        </video>
      </div>
    );
  }

  if (file.kind === "audio" && file.url) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-muted p-6">
        <div className="w-full max-w-2xl rounded-12 border border-border bg-surface p-6 shadow-1">
          <div className="mb-4 text-ui text-foreground">{title}</div>
          <audio controls preload="metadata" className="w-full">
            <source src={file.url} type={file.mimeType} />
          </audio>
        </div>
      </div>
    );
  }

  if (file.kind === "pdf" && file.url) {
    return (
      <div className="h-full bg-surface-muted p-4">
        <object
          data={file.url}
          type={file.mimeType}
          className="h-full w-full rounded-12 border border-border bg-surface shadow-1"
        >
          <iframe
            src={file.url}
            title={title}
            className="h-full w-full rounded-12 border border-border bg-surface shadow-1"
          />
        </object>
      </div>
    );
  }

  if (file.kind === "docx" && file.url) {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-surface p-6">
            <p className="text-ui text-subtle-foreground">{t("view.loadingDocument")}</p>
          </div>
        }
      >
        <DocxPreviewPane assetUrl={file.url} title={title} />
      </Suspense>
    );
  }

  if (file.kind === "binary" && file.url && isSpreadsheetPath(file.path)) {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-surface p-6">
            <p className="text-ui text-subtle-foreground">{t("view.loadingSpreadsheet")}</p>
          </div>
        }
      >
        <SpreadsheetPreviewPane assetUrl={file.url} size={file.size} title={title} />
      </Suspense>
    );
  }

  return (
    fallback ?? (
      <div className="flex h-full items-center justify-center bg-surface p-6">
        <div className="max-w-md text-center">
          <h3 className="text-section text-foreground">{t("view.unsupportedTitle")}</h3>
          <p className="mt-2 text-ui text-muted-foreground">{t("view.unsupportedDescription")}</p>
        </div>
      </div>
    )
  );
}
