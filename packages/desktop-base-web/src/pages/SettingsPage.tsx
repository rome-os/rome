import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { RomeLogo } from "@/components/RomeLogo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { RuntimeTargetCard } from "@/pages/RuntimeTargetCard";
import {
  errorMessage,
  romeApi,
  type RuntimePhase,
  type RuntimeStatus,
  type UpdaterState,
  type UpdateStatus,
} from "@/lib/rome-api";

const BUSY_PHASES: RuntimePhase[] = [
  "checking_host",
  "starting_runtime",
  "pulling_image",
  "starting_rome",
  "waiting_for_health",
];

type Tone = "muted" | "success" | "destructive";

function runtimeLabel(phase: RuntimePhase): { text: string; tone: Tone } {
  if (phase === "ready") return { text: "Running", tone: "success" };
  if (phase === "failed") return { text: "Needs attention", tone: "destructive" };
  if (phase === "installing_runtime") return { text: "Setup needed", tone: "destructive" };
  return { text: "Working…", tone: "muted" };
}

function updateLabel(state: UpdaterState): { text: string; tone: Tone } {
  switch (state) {
    case "not-available":
      return { text: "Up to date", tone: "success" };
    case "downloaded":
      return { text: "Ready to install", tone: "success" };
    case "available":
      return { text: "Update available", tone: "muted" };
    case "downloading":
      return { text: "Downloading", tone: "muted" };
    case "checking":
      return { text: "Checking", tone: "muted" };
    case "error":
      return { text: "Needs attention", tone: "destructive" };
    default:
      return { text: "Ready", tone: "muted" };
  }
}

function toneToBadgeVariant(tone: Tone): "secondary" | "destructive" | "success" {
  if (tone === "success") return "success";
  if (tone === "destructive") return "destructive";
  return "secondary";
}

function formatLastChecked(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function StatusBadge({ tone, text, busy }: { tone: Tone; text: string; busy?: boolean }) {
  return (
    <Badge variant={toneToBadgeVariant(tone)} className="gap-1.5">
      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
      {text}
    </Badge>
  );
}

export function SettingsPage() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [updater, setUpdater] = useState<UpdateStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [updaterError, setUpdaterError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [retryBusy, setRetryBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([romeApi.runtime.getStatus(), romeApi.updater.getStatus()])
      .then(([runtimeStatus, updaterStatus]) => {
        if (cancelled) return;
        setRuntime(runtimeStatus);
        setUpdater(updaterStatus);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    const offRuntime = romeApi.on("runtime:status", setRuntime);
    const offUpdater = romeApi.on("updater:status", setUpdater);
    return () => {
      cancelled = true;
      offRuntime();
      offUpdater();
    };
  }, [loadAttempt]);

  // The only recovery this window offers. A failed runtime leaves the dashboard
  // reachable, so the proxy answers 502 rather than refusing the connection and
  // window.ts's did-fail-load retry never sends the user back to onboarding.
  const handleRetry = useCallback(async () => {
    setRuntimeError(null);
    setRetryBusy(true);
    try {
      await romeApi.runtime.ensureReady();
    } catch (err) {
      setRuntimeError(errorMessage(err));
    } finally {
      setRetryBusy(false);
    }
  }, []);

  const handleOpenLogs = useCallback(async () => {
    setRuntimeError(null);
    try {
      await romeApi.runtime.openLogs();
    } catch (err) {
      setRuntimeError(errorMessage(err));
    }
  }, []);

  const handleUpdaterAction = useCallback(async () => {
    setUpdaterError(null);
    try {
      if (updater?.state === "available") {
        await romeApi.updater.download();
      } else {
        await romeApi.updater.check();
      }
    } catch (err) {
      setUpdaterError(errorMessage(err));
    }
  }, [updater]);

  const handleInstallUpdate = useCallback(async () => {
    setUpdaterError(null);
    try {
      await romeApi.updater.install();
    } catch (err) {
      setUpdaterError(errorMessage(err));
    }
  }, []);

  const handleAutoUpdateToggle = useCallback(async (enabled: boolean) => {
    setUpdaterError(null);
    try {
      await romeApi.updater.setAutoUpdateEnabled(enabled);
    } catch (err) {
      setUpdaterError(errorMessage(err));
    }
  }, []);

  // primaryAction is the manager's own "I am working" signal. A phase alone is
  // not: starting_runtime is a busy phase that also carries "Runtime did not
  // start", where nothing is running and the retry below is the way out.
  const runtimeBusy =
    !!runtime && BUSY_PHASES.includes(runtime.phase) && runtime.primaryAction === "none";
  const runtimeStatus = runtime ? runtimeLabel(runtime.phase) : null;
  const canRetry = !!runtime && (runtime.phase === "failed" || runtime.primaryAction === "retry");

  const runtimeMessage = (() => {
    if (!runtime) return "Checking…";
    if (runtime.lastError) return runtime.lastError;
    if (runtime.primaryAction === "retry") return runtime.detail;
    if (runtime.phase === "ready")
      return runtime.provider === "remote"
        ? "Rome is running in Rome Cloud."
        : "Rome is running on your computer.";
    if (runtime.phase === "installing_runtime")
      return "Rome needs a small helper to run. Finish setup to continue.";
    if (runtimeBusy) return "Setting things up. This will only take a moment.";
    return "Rome is not running.";
  })();

  const updateStatus = updater ? updateLabel(updater.state) : null;

  const updaterAction = (() => {
    if (!updater) return { label: "Check for updates", disabled: false, showInstall: false };
    switch (updater.state) {
      case "available":
        return { label: "Download update", disabled: false, showInstall: false };
      case "downloading":
        return { label: "Downloading…", disabled: true, showInstall: false };
      case "downloaded":
        return { label: "Update ready", disabled: true, showInstall: true };
      case "checking":
        return { label: "Checking…", disabled: true, showInstall: false };
      default:
        return { label: "Check for updates", disabled: false, showInstall: false };
    }
  })();

  const updaterMessage = (() => {
    if (!updater) return "";
    if (updater.state === "downloading" && updater.progress)
      return `Downloading update… ${Math.round(updater.progress.percent)}%`;
    if (updater.state === "downloaded" && updater.updateVersion)
      return `Version ${updater.updateVersion} is ready. Restart to finish.`;
    if (updater.state === "available" && updater.updateVersion)
      return `Version ${updater.updateVersion} is available.`;
    if (updater.state === "not-available") return "You're on the latest version.";
    if (updater.error) return updater.error;
    return "";
  })();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">
        <header className="space-y-3">
          <div className="flex items-center gap-2">
            <RomeLogo className="size-5" />
            <span className="text-sm font-semibold tracking-tight">Rome</span>
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">Manage Rome on this computer.</p>
          </div>
        </header>

        {loadError && !runtime && !updater ? (
          <Card>
            <CardContent className="space-y-4 pt-6">
              <p className="text-sm font-medium">Couldn't load settings.</p>
              <p className="text-sm text-muted-foreground">{loadError}</p>
              <Button
                size="sm"
                onClick={() => {
                  setLoadError(null);
                  setLoadAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <RuntimeTargetCard />

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div className="space-y-1.5">
                  <CardTitle>Rome</CardTitle>
                  {runtimeStatus && (
                    <StatusBadge
                      tone={runtimeStatus.tone}
                      text={runtimeStatus.text}
                      busy={runtimeBusy || retryBusy}
                    />
                  )}
                </div>
                {canRetry && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      handleRetry().catch(console.error);
                    }}
                    disabled={retryBusy || runtimeBusy}
                  >
                    {retryBusy ? "Starting…" : "Start Rome"}
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{runtimeMessage}</p>

                {runtimeError && <p className="text-sm text-destructive">{runtimeError}</p>}

                {/* Which backend this build runs. Pinned releases fix it, so this
                    is the only place that says which one. */}
                {runtime?.provider === "remote" ? (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Address</span>
                    <span className="font-mono text-xs">{runtime.dashboardUrl}</span>
                  </div>
                ) : (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Image</span>
                    <span className="font-mono text-xs">{runtime?.image ?? "—"}</span>
                  </div>
                )}

                <Separator />

                <button
                  type="button"
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => {
                    handleOpenLogs().catch(console.error);
                  }}
                >
                  View setup logs
                </button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                <div className="space-y-1.5">
                  <CardTitle>Rome app</CardTitle>
                  {updateStatus && (
                    <StatusBadge
                      tone={updateStatus.tone}
                      text={updateStatus.text}
                      busy={updater?.state === "checking" || updater?.state === "downloading"}
                    />
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    handleUpdaterAction().catch(console.error);
                  }}
                  disabled={updaterAction.disabled}
                >
                  {updaterAction.label}
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Current version</span>
                  <span className="font-medium">{updater?.currentVersion || "—"}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Last checked</span>
                  <span>{formatLastChecked(updater?.lastCheckedAt ?? null)}</span>
                </div>

                {updaterMessage && (
                  <p className="text-sm text-muted-foreground">{updaterMessage}</p>
                )}

                {updaterError && <p className="text-sm text-destructive">{updaterError}</p>}

                {updaterAction.showInstall && (
                  <Button
                    className="w-full"
                    onClick={() => {
                      handleInstallUpdate().catch(console.error);
                    }}
                  >
                    Restart to install
                  </Button>
                )}

                <Separator />

                <label
                  className="flex items-center justify-between gap-4"
                  htmlFor="updater-auto-enabled"
                >
                  <span className="text-sm">Install updates automatically</span>
                  <Switch
                    id="updater-auto-enabled"
                    checked={!!updater?.autoUpdateEnabled}
                    onCheckedChange={(checked) => {
                      handleAutoUpdateToggle(checked).catch(console.error);
                    }}
                  />
                </label>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
