import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import Markdown from "@/components/markdown";
import { IconButton } from "@/components/ui/icon-button";
import { MonacoFileEditor } from "@/components/monaco-file-editor";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";
import {
  getDelimitedSeparator,
  getTextPreviewKind,
  parseDelimitedContent,
} from "@/lib/file-preview";

const DocxPreviewPane = lazy(() =>
  import("@/components/docx-preview-pane").then((module) => ({
    default: module.DocxPreviewPane,
  })),
);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function FileViewHeader({ onMobileBack }: { onMobileBack: () => void }) {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const selectedPath = useFileBrowserStore((s) => s.selection.selectedPath);
  const selectedFile = useFileBrowserStore((s) => s.file.selectedFile);
  const textViewMode = useFileBrowserStore((s) => s.file.textViewMode);
  const showHistory = useFileBrowserStore((s) => s.ui.showHistory);
  const saving = useFileBrowserStore((s) => s.file.saving);
  const autoSaveState = useFileBrowserStore((s) => s.file.autoSaveState);
  const content = useFileBrowserStore((s) => s.file.content);
  const lastDiskContent = useFileBrowserStore((s) => s.file.lastDiskContent);
  const committedContent = useFileBrowserStore((s) => s.file.committedContent);

  const textPreviewKind =
    selectedFile?.kind === "text"
      ? getTextPreviewKind(selectedFile.path, selectedFile.mimeType)
      : null;

  const hasChanges = selectedFile?.editable ? content !== committedContent : false;
  const hasUnflushedDiskWrites = selectedFile?.editable ? content !== lastDiskContent : false;
  const hasUnresolvedEdits = hasChanges || hasUnflushedDiskWrites;

  const autoSavePolicy = selectedFile?.editable
    ? store.getState().file.resolveAutoSavePolicy(selectedFile)
    : null;
  const autoSaveStatusLabel =
    autoSavePolicy && selectedFile?.editable
      ? autoSaveState === "pending"
        ? t("status.autoSavePending")
        : autoSaveState === "saving"
          ? t("status.autoSaving")
          : autoSaveState === "saved"
            ? t("status.autoSaved")
            : autoSaveState === "error"
              ? t("status.autoSaveFailed")
              : null
      : null;

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2 md:gap-3 md:px-6">
      <IconButton
        onClick={onMobileBack}
        label={t("header.backToFiles")}
        icon={<ArrowLeft aria-hidden />}
        className="text-muted-foreground hover:bg-surface-muted hover:text-foreground @min-[1024px]/fb:hidden"
      />
      <div className="min-w-0 flex-1">
        {(() => {
          const path = selectedPath ?? "";
          const lastSlash = path.lastIndexOf("/");
          const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
          const dirPath = lastSlash >= 0 ? path.slice(0, lastSlash) : "";
          return (
            <>
              <div className="truncate font-mono text-ui text-foreground">{fileName || path}</div>
              {selectedFile && (
                <div className="mt-1 truncate font-mono text-aux text-muted-foreground">
                  {dirPath && (
                    <>
                      <span>{dirPath}</span>
                      <span className="mx-2 text-subtle-foreground">·</span>
                    </>
                  )}
                  <span>{selectedFile.mimeType}</span>
                  <span className="mx-2 text-subtle-foreground">·</span>
                  <span>{formatBytes(selectedFile.size)}</span>
                </div>
              )}
            </>
          );
        })()}
      </div>
      <div className="flex shrink-0 items-center gap-2 md:gap-2">
        {textPreviewKind && selectedFile?.editable && (
          <>
            <SegmentedControl
              size="sm"
              aria-label={t("view.modeLabel")}
              value={textViewMode}
              onValueChange={(next: string) =>
                store.getState().file.setTextViewMode(next as "preview" | "edit")
              }
              className="hidden @min-[1024px]/fb:inline-flex"
              options={[
                { value: "preview", label: t("view.preview") },
                { value: "edit", label: t("view.edit") },
              ]}
            />
            <button
              type="button"
              onClick={() => store.getState().file.toggleTextViewMode()}
              className="rounded-8 p-2 text-muted-foreground hover:bg-surface-muted hover:text-foreground @min-[1024px]/fb:hidden"
              aria-label={
                textViewMode === "edit" ? t("view.showPreview") : t("view.switchToEditor")
              }
            >
              {textViewMode === "edit" ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              )}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            if (showHistory) {
              store.getState().ui.setShowHistory(false);
              return;
            }
            void store.getState().ui.loadHistory();
          }}
          className={`hidden rounded-8 px-3 py-1 text-ui @min-[1024px]/fb:inline-flex ${
            showHistory
              ? "bg-info-bg text-info-fg"
              : "bg-surface-muted text-foreground hover:bg-border"
          }`}
        >
          {t("view.history")}
        </button>
        <button
          type="button"
          onClick={() => {
            if (showHistory) {
              store.getState().ui.setShowHistory(false);
              return;
            }
            void store.getState().ui.loadHistory();
          }}
          className={`rounded-8 p-2 @min-[1024px]/fb:hidden ${
            showHistory
              ? "bg-info-bg text-info-fg"
              : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
          }`}
          aria-label={showHistory ? t("view.hideHistory") : t("view.showHistory")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l3 2" />
          </svg>
        </button>
        {selectedFile?.editable ? (
          <>
            {autoSaveStatusLabel ? (
              <span
                className={`hidden text-aux @min-[1024px]/fb:inline ${
                  autoSaveState === "error" ? "text-destructive" : "text-subtle-foreground"
                }`}
              >
                {autoSaveStatusLabel}
              </span>
            ) : null}
            <Button
              type="button"
              onClick={() => void store.getState().file.saveFile()}
              disabled={saving || !hasUnresolvedEdits}
            >
              {saving ? t("status.saving") : t("status.save")}
            </Button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => selectedPath && store.getState().ui.downloadPaths([selectedPath])}
          disabled={!selectedPath}
          title={t("contextMenu.download")}
          aria-label={t("contextMenu.download")}
          className="rounded-8 p-2 text-muted-foreground hover:bg-surface-muted hover:text-foreground disabled:opacity-50"
        >
          <Download className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function FileViewBody() {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const selectedFile = useFileBrowserStore((s) => s.file.selectedFile);
  const selectedPath = useFileBrowserStore((s) => s.selection.selectedPath);
  const loadingFile = useFileBrowserStore((s) => s.file.loadingFile);
  const content = useFileBrowserStore((s) => s.file.content);
  const textViewMode = useFileBrowserStore((s) => s.file.textViewMode);

  const textPreviewKind =
    selectedFile?.kind === "text"
      ? getTextPreviewKind(selectedFile.path, selectedFile.mimeType)
      : null;

  const delimitedRows = useMemo(() => {
    if (!selectedFile || textPreviewKind !== "delimited") return [];
    return parseDelimitedContent(
      content,
      getDelimitedSeparator(selectedFile.path, selectedFile.mimeType),
    );
  }, [content, selectedFile, textPreviewKind]);

  if (loadingFile) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <p className="text-ui text-subtle-foreground">{t("view.loadingFile")}</p>
      </div>
    );
  }

  if (
    selectedFile?.kind === "text" &&
    textViewMode === "preview" &&
    textPreviewKind === "markdown"
  ) {
    return (
      <div className="h-full overflow-auto bg-surface p-4 md:p-6">
        <Markdown className="text-foreground">{content}</Markdown>
      </div>
    );
  }

  if (
    selectedFile?.kind === "text" &&
    textViewMode === "preview" &&
    textPreviewKind === "delimited"
  ) {
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

  if (selectedFile?.kind === "text" && textViewMode === "preview" && textPreviewKind === "html") {
    if (!selectedFile.assetUrl) {
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
          src={selectedFile.assetUrl}
          title={selectedPath ?? ""}
          sandbox="allow-forms allow-modals allow-popups allow-scripts"
          className="h-full w-full rounded-12 border border-border bg-white shadow-1"
        />
      </div>
    );
  }

  if (selectedFile?.kind === "text" && selectedPath) {
    return (
      <div className="h-full w-full bg-surface">
        <MonacoFileEditor
          path={selectedPath}
          value={content}
          onChange={(next) => store.getState().file.setContent(next)}
          onBlur={() => void store.getState().file.flushAutoSave()}
          readOnly={!selectedFile.editable}
        />
      </div>
    );
  }

  if (selectedFile?.kind === "image" && selectedFile.assetUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-surface-muted p-6">
        <img
          src={selectedFile.assetUrl}
          alt={selectedPath ?? ""}
          className="max-h-full max-w-full rounded-12 border border-border bg-surface object-contain shadow-1"
        />
      </div>
    );
  }

  if (selectedFile?.kind === "video" && selectedFile.assetUrl) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-surface-muted p-6">
        <video
          controls
          preload="metadata"
          className="max-h-full max-w-full rounded-12 bg-foreground shadow-1"
        >
          <source src={selectedFile.assetUrl} type={selectedFile.mimeType} />
        </video>
      </div>
    );
  }

  if (selectedFile?.kind === "audio" && selectedFile.assetUrl) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-muted p-6">
        <div className="w-full max-w-2xl rounded-12 border border-border bg-surface p-6 shadow-1">
          <div className="mb-4 text-ui text-foreground">{selectedPath}</div>
          <audio controls preload="metadata" className="w-full">
            <source src={selectedFile.assetUrl} type={selectedFile.mimeType} />
          </audio>
        </div>
      </div>
    );
  }

  if (selectedFile?.kind === "pdf" && selectedFile.assetUrl) {
    return (
      <div className="h-full bg-surface-muted p-4">
        <object
          data={selectedFile.assetUrl}
          type={selectedFile.mimeType}
          className="h-full w-full rounded-12 border border-border bg-surface shadow-1"
        >
          <iframe
            src={selectedFile.assetUrl}
            title={selectedPath ?? ""}
            className="h-full w-full rounded-12 border border-border bg-surface shadow-1"
          />
        </object>
      </div>
    );
  }

  if (selectedFile?.kind === "docx" && selectedFile.assetUrl) {
    return (
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-surface p-6">
            <p className="text-ui text-subtle-foreground">{t("view.loadingDocument")}</p>
          </div>
        }
      >
        <DocxPreviewPane assetUrl={selectedFile.assetUrl} title={selectedPath ?? ""} />
      </Suspense>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-surface p-6">
      <div className="max-w-md text-center">
        <h3 className="text-section text-foreground">{t("view.unsupportedTitle")}</h3>
        <p className="mt-2 text-ui text-muted-foreground">{t("view.unsupportedDescription")}</p>
      </div>
    </div>
  );
}
