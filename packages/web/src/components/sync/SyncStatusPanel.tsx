import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitBranch,
  Globe,
  Link2,
  Lock,
  RotateCcw,
} from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import {
  getSyncStatus,
  presentSyncState,
  resetSyncToDefault,
  runSync,
  type SyncStatePresentation,
  type SyncStatus,
} from "@/lib/sync-api";
import { ChangedFilesDialog } from "./ChangedFilesDialog";
import { SourceConnect } from "./SourceConnect";
import { SourceIcon } from "./source-icon";

interface SyncStatusPanelProps {
  /** The project's relative path (e.g. "myproject"). */
  path: string;
  className?: string;
}

const TONE_DOT: Record<SyncStatePresentation["tone"], string> = {
  neutral: "bg-muted-foreground/50",
  ok: "bg-success",
  busy: "bg-info",
  attention: "bg-warning",
  error: "bg-destructive",
};

function relativeTime(iso?: string): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function SyncStatusPanel({ path, className }: SyncStatusPanelProps) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await getSyncStatus(path));
    } catch {
      setStatus({ state: "error", message: "Couldn't load status" });
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doSync = useCallback(
    async (direction: "push" | "pull" | "both") => {
      setBusy(true);
      try {
        setStatus(await runSync(path, direction));
      } catch (err) {
        setStatus((prev) => ({
          state: "error",
          message: err instanceof Error ? err.message : "Sync failed",
          remoteLabel: prev?.remoteLabel,
          remoteUrl: prev?.remoteUrl,
        }));
      } finally {
        setBusy(false);
      }
    },
    [path],
  );

  const resetToDefault = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await resetSyncToDefault(path));
    } catch (err) {
      try {
        setStatus(await getSyncStatus(path));
      } catch {
        setStatus((prev) => ({
          state: "error",
          message: err instanceof Error ? err.message : "Reset failed",
          remoteLabel: prev?.remoteLabel,
        }));
      }
    } finally {
      setBusy(false);
    }
  }, [path]);

  if (loading && !status) {
    return (
      <div className={`flex items-center gap-2 text-ui text-subtle-foreground ${className ?? ""}`}>
        <Spinner label="Loading sync status" /> <span aria-hidden>Loading sync status…</span>
      </div>
    );
  }

  const state = status?.state ?? "unlinked";
  const presentation = presentSyncState(state);

  if (state === "unlinked") {
    return (
      <Card className={className}>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-section">Sync</p>
              <p className="text-aux text-muted-foreground">Not connected to any source</p>
            </div>
            <Button size="sm" onClick={() => setConnectOpen(true)}>
              <Link2 data-icon="inline-start" className="size-4" aria-hidden /> Connect…
            </Button>
          </div>
          <SourceConnect
            mode="link"
            projectPath={path}
            open={connectOpen}
            onClose={() => setConnectOpen(false)}
            onLinked={() => void refresh()}
          />
        </CardContent>
      </Card>
    );
  }

  const changes = status?.changes;
  const changeTotal = changes ? changes.added + changes.modified + changes.removed : 0;
  const canResetToDefault =
    changeTotal === 0 && !!status?.ref && !!status.defaultRef && status.ref !== status.defaultRef;
  const lastSynced = relativeTime(status?.lastSyncedAt);

  return (
    <Card className={className}>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${TONE_DOT[presentation.tone]}`} aria-hidden />
              <span className="text-section">{presentation.label}</span>
            </div>
            {status?.remoteLabel ? (
              <p
                className="flex items-center gap-2 truncate text-aux text-muted-foreground"
                title={status.remoteUrl ?? status.remoteLabel}
              >
                <SourceIcon source={status.sourceId} className="size-3.5 shrink-0" />
                {status.remoteUrl ? (
                  <a
                    href={status.remoteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="min-w-0 truncate rounded-4 underline-offset-2 transition hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {status.remoteLabel}
                  </a>
                ) : (
                  <span className="truncate">{status.remoteLabel}</span>
                )}
                {status.private !== undefined ? (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-muted px-2 py-1 text-badge text-muted-foreground"
                    title={status.private ? "Private repository" : "Public repository"}
                  >
                    {status.private ? (
                      <Lock className="size-2.5" aria-hidden />
                    ) : (
                      <Globe className="size-2.5" aria-hidden />
                    )}
                    {status.private ? "Private" : "Public"}
                  </span>
                ) : null}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-aux text-subtle-foreground">
              {status?.ref ? (
                <span className="inline-flex items-center gap-1">
                  <GitBranch className="size-3" aria-hidden /> {status.ref}
                </span>
              ) : null}
              {changeTotal > 0 ? (
                <button
                  type="button"
                  onClick={() => setChangesOpen(true)}
                  title="View changed files"
                  className="rounded-4 underline-offset-2 transition hover:text-foreground hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {changeTotal} local change{changeTotal === 1 ? "" : "s"}
                </button>
              ) : null}
              {status?.ahead ? <span>↑{status.ahead}</span> : null}
              {status?.behind ? <span>↓{status.behind}</span> : null}
              {lastSynced ? <span>synced {lastSynced}</span> : null}
            </div>
            {status?.message && presentation.tone === "error" ? (
              <p className="text-aux text-destructive-fg">{status.message}</p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              size="sm"
              label="Get updates"
              icon={<ArrowDownToLine />}
              onClick={() => void doSync("pull")}
              disabled={busy}
            />
            <IconButton
              size="sm"
              label="Upload changes"
              icon={<ArrowUpFromLine />}
              onClick={() => void doSync("push")}
              disabled={busy}
            />
            {canResetToDefault ? (
              <IconButton
                size="sm"
                label={`Reset to ${status.defaultRef} branch`}
                icon={
                  busy ? (
                    <Spinner size="sm" label={`Resetting to ${status.defaultRef} branch`} />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )
                }
                onClick={() => void resetToDefault()}
                disabled={busy}
              />
            ) : null}
          </div>
        </div>

        <ChangedFilesDialog
          path={path}
          remoteLabel={status?.remoteLabel}
          open={changesOpen}
          onClose={() => setChangesOpen(false)}
          onChangesRestored={() => void refresh()}
        />
      </CardContent>
    </Card>
  );
}
