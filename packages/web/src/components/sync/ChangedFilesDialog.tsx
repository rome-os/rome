import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Check, FileDiff, Undo2 } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getSyncChangeDiff,
  getSyncChanges,
  restoreAllSyncChanges,
  restoreSyncChange,
  type ChangedFile,
  type ChangeDiff,
} from "@/lib/sync-api";
import { cn } from "@/lib/utils";
import { UnifiedDiffViewer } from "./UnifiedDiffViewer";

/** Per-change presentation: a one-letter source-control badge (A/M/D), the badge
 * colors, and a summary dot — all wired to semantic tokens. */
const CHANGE_META: Record<
  ChangedFile["change"],
  { label: string; letter: string; badge: string; dot: string }
> = {
  added: { label: "added", letter: "A", badge: "bg-success-bg text-success-fg", dot: "bg-success" },
  modified: {
    label: "modified",
    letter: "M",
    badge: "bg-warning-bg text-warning-fg",
    dot: "bg-warning",
  },
  removed: {
    label: "removed",
    letter: "D",
    badge: "bg-destructive-bg text-destructive-fg",
    dot: "bg-destructive",
  },
};

const CHANGE_ORDER: ChangedFile["change"][] = ["added", "modified", "removed"];

/** Split a path into its dimmable directory prefix and its emphasized basename. */
function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

interface ChangedFilesDialogProps {
  /** The project's relative path — same key the status panel uses. */
  path: string;
  /** The linked remote (e.g. "github.com/owner/repo"), shown as a subheading. */
  remoteLabel?: string;
  open: boolean;
  onClose: () => void;
  onChangesRestored?: () => void;
}

export function ChangedFilesDialog({
  path,
  remoteLabel,
  open,
  onClose,
  onChangesRestored,
}: ChangedFilesDialogProps) {
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringPath, setRestoringPath] = useState<string | null>(null);
  const [restoringAll, setRestoringAll] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ChangedFile | null>(null);
  const [diff, setDiff] = useState<ChangeDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFiles(null);
    setError(null);
    setSelectedFile(null);
    setDiff(null);
    setDiffError(null);
    getSyncChanges(path)
      .then((result) => {
        if (!cancelled) setFiles(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Couldn't load changes");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  useEffect(() => {
    if (!open || !selectedFile) return;
    let cancelled = false;
    setDiffLoading(true);
    setDiff(null);
    setDiffError(null);
    getSyncChangeDiff(path, selectedFile.path)
      .then((result) => {
        if (!cancelled) setDiff(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setDiffError(err instanceof Error ? err.message : "Couldn't load the file diff");
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path, selectedFile]);

  const summary = useMemo(
    () =>
      CHANGE_ORDER.map((change) => ({
        change,
        count: files?.filter((f) => f.change === change).length ?? 0,
      })).filter((entry) => entry.count > 0),
    [files],
  );

  const total = files?.length ?? 0;

  async function restore(file: ChangedFile): Promise<void> {
    setRestoringPath(file.path);
    setError(null);
    try {
      setFiles(await restoreSyncChange(path, file.path));
      onChangesRestored?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't undo change");
    } finally {
      setRestoringPath(null);
    }
  }

  async function restoreAll(): Promise<void> {
    setRestoringAll(true);
    setError(null);
    try {
      setFiles(await restoreAllSyncChanges(path));
      onChangesRestored?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't undo changes");
    } finally {
      setRestoringAll(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel="Local changes"
      size={selectedFile ? "lg" : "md"}
    >
      <DialogHeader onClose={onClose}>
        {selectedFile ? (
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Back to changed files"
              title="Back to changed files"
              onClick={() => setSelectedFile(null)}
            >
              <ArrowLeft aria-hidden />
            </Button>
            <DialogTitle className="truncate text-section" title={selectedFile.path}>
              {selectedFile.path}
            </DialogTitle>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <FileDiff className="size-4 text-muted-foreground" aria-hidden />
            <DialogTitle>Local changes</DialogTitle>
          </div>
        )}
        {remoteLabel ? (
          <p className="mt-1 truncate text-aux text-muted-foreground" title={remoteLabel}>
            {remoteLabel}
          </p>
        ) : null}
      </DialogHeader>

      <DialogBody className={cn(selectedFile ? "p-0" : "space-y-3")}>
        {selectedFile ? (
          <div aria-live="polite">
            {diffLoading ? (
              <div className="space-y-2 px-4 py-4" aria-label="Loading file diff">
                <Skeleton className="h-8 w-full" />
                {Array.from({ length: 9 }).map((_, i) => (
                  <Skeleton key={i} className="h-4" style={{ width: `${76 + ((i * 7) % 24)}%` }} />
                ))}
              </div>
            ) : null}
            {diffError ? (
              <div className="p-4">
                <Alert variant="destructive">
                  <AlertTriangle aria-hidden />
                  <AlertDescription>{diffError}</AlertDescription>
                </Alert>
              </div>
            ) : null}
            {diff ? <UnifiedDiffViewer diff={diff} /> : null}
          </div>
        ) : (
          <>
            {error ? (
              <Alert variant="destructive">
                <AlertTriangle aria-hidden />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            {!files && !error ? (
              <ul className="space-y-1" aria-hidden>
                {Array.from({ length: 6 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-2 px-2 py-1">
                    <Skeleton className="size-5 rounded-8" />
                    <Skeleton className="h-3" style={{ width: `${40 + ((i * 13) % 45)}%` }} />
                  </li>
                ))}
              </ul>
            ) : null}

            {!loading && !error && files && files.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <span className="flex size-9 items-center justify-center rounded-full bg-success-bg">
                  <Check className="size-5 text-success-fg" aria-hidden />
                </span>
                <p className="text-ui text-muted-foreground">
                  No local changes — everything is in sync.
                </p>
              </div>
            ) : null}

            {files && files.length > 0 ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-aux text-muted-foreground">
                    <span className="text-foreground">
                      {total} file{total === 1 ? "" : "s"} changed
                    </span>
                    {summary.map(({ change, count }) => (
                      <span key={change} className="inline-flex items-center gap-2">
                        <span
                          className={cn("size-1.5 rounded-full", CHANGE_META[change].dot)}
                          aria-hidden
                        />
                        {count} {CHANGE_META[change].label}
                      </span>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="destructive"
                    size="xs"
                    disabled={restoringPath !== null || restoringAll}
                    aria-label={restoringAll ? "Undoing all changes" : undefined}
                    onClick={() => void restoreAll()}
                  >
                    {restoringAll ? (
                      <Spinner size="xs" label="Undoing all changes" />
                    ) : (
                      <Undo2 aria-hidden />
                    )}
                    Undo all
                  </Button>
                </div>

                <ul className="space-y-1">
                  {files.map((file) => {
                    const meta = CHANGE_META[file.change];
                    const { dir, name } = splitPath(file.path);
                    return (
                      <li key={`${file.change}:${file.path}`}>
                        <div className="group flex items-center gap-1 rounded-8 transition hover:bg-surface-muted focus-within:bg-surface-muted">
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-8 px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={`View diff for ${file.path}`}
                            onClick={() => setSelectedFile(file)}
                          >
                            <span
                              className={cn(
                                "flex size-5 shrink-0 items-center justify-center rounded-8 text-badge",
                                meta.badge,
                              )}
                              title={meta.label}
                              aria-label={meta.label}
                            >
                              {meta.letter}
                            </span>
                            <span
                              className="flex min-w-0 flex-1 items-center font-mono text-aux"
                              title={file.path}
                            >
                              {dir ? (
                                <span className="min-w-0 truncate text-subtle-foreground">
                                  {dir}
                                </span>
                              ) : null}
                              <span className="shrink-0 text-foreground">{name}</span>
                            </span>
                          </button>
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            className="mr-1"
                            title={`Undo ${file.path}`}
                            disabled={restoringPath !== null || restoringAll}
                            aria-label={
                              restoringPath === file.path
                                ? `Undoing changes to ${file.path}`
                                : `Undo ${file.path}`
                            }
                            onClick={() => void restore(file)}
                          >
                            {restoringPath === file.path ? (
                              <Spinner size="xs" label={`Undoing changes to ${file.path}`} />
                            ) : (
                              <Undo2 aria-hidden />
                            )}
                            Undo
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}
