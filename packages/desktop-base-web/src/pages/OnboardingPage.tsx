import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";

import { RomeLogo } from "@/components/RomeLogo";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { romeApi, type RuntimePhase, type RuntimeStatus } from "@/lib/rome-api";
import { cn } from "@/lib/utils";
import { RemoteWelcome } from "@/pages/RemoteWelcome";

type StepState = "pending" | "active" | "done";

const RUNTIME_PHASES: RuntimePhase[] = ["checking_host", "installing_runtime", "starting_runtime"];
const IMAGE_PHASES: RuntimePhase[] = ["pulling_image", "starting_rome"];

interface StepView {
  id: "runtime" | "image" | "launch";
  title: string;
  detail: string;
  state: StepState;
}

function deriveSteps(status: RuntimeStatus): StepView[] {
  const runtimeReady = status.runtimeInstalled && status.runtimeRunning;
  const imageDone = status.phase === "ready" || status.phase === "waiting_for_health";
  const launchDone = status.phase === "ready";

  // Narrow on purpose. A retry is offered for a port conflict, a failed pull, a
  // health timeout and more, and none of those say the runtime failed to start
  // — a port conflict is raised before the host is even probed, and the rest
  // happen with it up. Keying this step off the action alone put "Did not
  // finish starting." under a step already showing a tick. Only this pairing
  // means the runtime itself is the thing that did not come up.
  const runtimeStartFailed =
    status.phase === "starting_runtime" && status.primaryAction === "retry";

  const runtimeState: StepState =
    runtimeReady && !RUNTIME_PHASES.includes(status.phase)
      ? "done"
      : RUNTIME_PHASES.includes(status.phase) && !runtimeStartFailed
        ? "active"
        : "pending";

  const imageState: StepState = imageDone
    ? "done"
    : IMAGE_PHASES.includes(status.phase)
      ? "active"
      : "pending";

  const launchState: StepState = launchDone
    ? "done"
    : status.phase === "waiting_for_health"
      ? "active"
      : "pending";

  const runtimeDetail = runtimeStartFailed
    ? "Did not finish starting."
    : !status.runtimeInstalled
      ? "A small one-time helper is needed."
      : !status.runtimeRunning
        ? "Starting it up."
        : "Done.";

  const imageDetail =
    status.phase === "pulling_image"
      ? "Downloading the Rome runtime."
      : status.phase === "starting_rome"
        ? // The manager's own words. It writes a distinct line when the health
          // wait failed and it is rebuilding, and hardcoding copy here threw
          // that away — leaving the steps to rewind with no reason given.
          status.detail
        : imageDone
          ? "Done."
          : "Up next.";

  const launchDetail =
    status.phase === "ready"
      ? "Opening Rome now."
      : status.phase === "waiting_for_health"
        ? status.detail
        : "Up next.";

  return [
    { id: "runtime", title: "Preparing your computer", detail: runtimeDetail, state: runtimeState },
    { id: "image", title: "Downloading Rome", detail: imageDetail, state: imageState },
    { id: "launch", title: "Opening the app", detail: launchDetail, state: launchState },
  ];
}

interface PrimaryView {
  label: string;
  visible: boolean;
  variant?: "default" | "outline";
}

function primaryView(status: RuntimeStatus): PrimaryView {
  switch (status.primaryAction) {
    case "install_runtime":
      return { label: "Install helper", visible: true };
    case "open_runtime_app":
      return { label: "Continue", visible: true };
    case "retry":
      return { label: "Try again", visible: true };
    case "open_dashboard":
      return { label: "Open Rome", visible: true };
    default:
      return { label: "", visible: false };
  }
}

function headline(status: RuntimeStatus): { title: string; subtitle: string } {
  if (status.phase === "ready") {
    return { title: "Rome is ready", subtitle: "Opening now…" };
  }
  // Every state that offers a retry, not only `failed`: the runtime failing to
  // start leaves the phase on `starting_runtime` with a Try again button, and
  // the fallback below would tell that screen it can be left running.
  if (status.primaryAction === "retry") {
    return {
      title: "Setup needs your attention",
      subtitle: "Something went wrong. Try again, or view the logs below.",
    };
  }
  if (status.primaryAction === "install_runtime") {
    return {
      title: "One last thing",
      subtitle: "Rome needs a small helper to run on your computer.",
    };
  }
  return {
    title: "Setting up Rome",
    subtitle:
      "Rome downloads its runtime and sets up a private Linux environment. It usually takes a few minutes — you can leave this running.",
  };
}

/**
 * Counts seconds inside a phase that reports no progress of its own.
 *
 * `starting_runtime` creates a VM and `waiting_for_health` polls a socket for
 * as long as its budget allows, and neither emits a status update while it
 * works — so the counter drives its own re-render instead of riding `status`.
 * Without it the screen is identical whether the boot is advancing or wedged,
 * which is the question a user is actually asking before they force-quit.
 */
function ElapsedNote({ phase }: { phase: RuntimePhase }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    // Wall clock, not a tick count. This is a tray-resident app whose window
    // hides rather than closes, and the subtitle invites leaving it running, so
    // a hidden renderer is the normal case — Chromium throttles its timers to
    // roughly one a minute after a few minutes of that. Counting ticks would
    // report a minute where nine had passed, understating exactly the wait the
    // counter exists to expose. The backend deadline is wall clock too
    // (`waitForSocketHealth` measures `Date.now() - startedAt`), and machine
    // sleep counts against it, so both clocks have to be the same one.
    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // Silent below 45s — a normal step finishing quickly should not sprout a timer.
  if (seconds < 45) return null;
  const minutes = Math.floor(seconds / 60);
  const label = minutes < 1 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
  return <span> · {label}</span>;
}

export function OnboardingPage() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [primaryBusy, setPrimaryBusy] = useState(false);
  const startupRequested = useRef(false);

  useEffect(() => {
    const off = romeApi.on("runtime:status", (next) => {
      setStatus(next);
      if (next.phase === "ready") {
        window.setTimeout(() => {
          window.location.href = next.dashboardUrl;
        }, 600);
      }
    });

    (async () => {
      const current = await romeApi.runtime.getStatus();
      setStatus(current);
      if (!startupRequested.current && current.phase !== "ready") {
        startupRequested.current = true;
        await romeApi.runtime.ensureReady();
      }
    })().catch(console.error);

    return off;
  }, []);

  const handlePrimary = useCallback(async () => {
    if (!status || primaryBusy) return;
    setPrimaryBusy(true);
    try {
      switch (status.primaryAction) {
        case "install_runtime":
          await romeApi.runtime.openInstallPage();
          return;
        case "open_runtime_app":
          await romeApi.runtime.startRuntimeApp();
          await romeApi.runtime.ensureReady();
          return;
        case "retry":
          await romeApi.runtime.ensureReady();
          return;
        case "open_dashboard":
          window.location.href = status.dashboardUrl;
          return;
      }
    } finally {
      setPrimaryBusy(false);
    }
  }, [status, primaryBusy]);

  const view = useMemo(() => {
    if (!status) return null;
    return {
      steps: deriveSteps(status),
      primary: primaryView(status),
      ...headline(status),
    };
  }, [status]);

  // Every retry state, not only `failed`. A runtime that did not start stays on
  // `starting_runtime` and offers a Try again button, and gating on the phase
  // meant the one line explaining why never reached the screen.
  const stalledHint =
    status?.primaryAction === "retry" ? (status.lastError ?? status.detail) : null;

  if (!status || !view) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="app-drag fixed inset-x-0 top-0 z-50 h-10" aria-hidden="true" />
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col px-6 pb-8 pt-12">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RomeLogo className="size-5" />
            <span className="text-sm font-semibold tracking-tight">Rome</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="app-no-drag"
            onClick={() => {
              romeApi.settings.openWindow().catch(console.error);
            }}
          >
            Settings
          </Button>
        </header>

        <main className="flex flex-1 flex-col justify-center gap-8 py-10">
          {status.provider === "remote" ? (
            <RemoteWelcome status={status} />
          ) : (
            <>
              <div className="space-y-2">
                <h1 className="text-2xl font-semibold tracking-tight">{view.title}</h1>
                <p className="text-sm text-muted-foreground">{view.subtitle}</p>
              </div>

              <Card className="overflow-hidden p-0">
                <CardContent className="p-0">
                  <ol className="divide-y">
                    {view.steps.map((step) => (
                      <li
                        key={step.id}
                        className={cn(
                          "flex items-start gap-3 px-5 py-4 transition-opacity",
                          step.state === "pending" && "opacity-50",
                        )}
                      >
                        <StepIndicator state={step.state} />
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-sm font-medium leading-none">{step.title}</p>
                          <p className="text-sm text-muted-foreground">
                            {step.detail}
                            {/* `primaryAction === "none"` is the manager's own
                            signal that it is working — every waiting-on-the-user
                            state names a button instead. Without it the counter
                            ticks on `installing_runtime` and on a
                            `starting_runtime` that already failed, both of which
                            sit behind a button having returned, and it would be
                            claiming progress on the very screen that asks the
                            user to act. Suppressed by phase rather than step id
                            for `pulling_image` alone: the image step stays
                            active through `starting_rome`, where the bar does
                            not render and the wait is silent again. */}
                            {status.primaryAction === "none" &&
                              step.state === "active" &&
                              status.phase !== "pulling_image" && (
                                <ElapsedNote phase={status.phase} />
                              )}
                          </p>
                          {step.id === "image" && status.phase === "pulling_image" && (
                            <PullProgress status={status} />
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            </>
          )}

          {status.provider !== "remote" && stalledHint && (
            <p className="text-sm text-destructive">{stalledHint}</p>
          )}

          {status.provider !== "remote" && view.primary.visible && (
            <Button
              className="w-full"
              disabled={primaryBusy}
              onClick={() => {
                handlePrimary().catch(console.error);
              }}
            >
              {primaryBusy && <Loader2 className="size-4 animate-spin" />}
              {view.primary.label}
            </Button>
          )}
        </main>

        {status.provider !== "remote" && (
          <footer className="flex justify-center pt-2">
            <button
              type="button"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                romeApi.runtime.openLogs().catch(console.error);
              }}
            >
              Having trouble? View setup logs
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function StepIndicator({ state }: { state: StepState }) {
  if (state === "done") {
    return (
      <span className="mt-0.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Check className="size-3" strokeWidth={3} />
      </span>
    );
  }
  if (state === "active") {
    return (
      <span className="mt-0.5 flex size-5 items-center justify-center text-primary">
        <Loader2 className="size-4 animate-spin" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 flex size-5 items-center justify-center">
      <span className="size-2 rounded-full border border-muted-foreground/40" />
    </span>
  );
}

function PullProgress({ status }: { status: RuntimeStatus }) {
  const progress = status.pullProgress;
  const percent = progress?.percent ?? null;
  // The parser reports null on purpose once the pull moves to unpacking, and
  // again while retrying — it means "indeterminate". Progress renders null as
  // 0%, so passing it straight through empties the bar at the exact moment the
  // download finishes, which reads as "it started over". Hold the high-water
  // mark and pulse instead. A ref, not state: this feeds render output only, and
  // writing it during render is idempotent, so a double-invoked or discarded
  // render cannot move it anywhere it has not already been.
  //
  // The high-water mark has to win over a *non-null* percent too, not only over
  // null. `spawnPullWithProgress` builds a fresh PullProgressParser per attempt,
  // so a network retry re-announces resumed layers from a low percentage —
  // monotonic within one parser, not across the pull the user is watching.
  // containerd resumes the partial layers, so the real bytes never regress and
  // only the parser's view of them does.
  const held = useRef(0);
  if (percent !== null && percent > held.current) held.current = percent;

  // Intentionally hide raw byte counts — the image is multiple GB and showing
  // it can alarm first-time users. Percent + phase text is enough signal.
  // Reads the held value, not `percent`, for the same reason the bar does — a
  // retry re-announcing resumed layers would otherwise put "5%" under a bar
  // sitting at 60%, and hand that number to `aria-valuetext` besides.
  const label =
    percent !== null
      ? `${Math.round(held.current)}%`
      : progress?.status || "Preparing image download";

  return (
    <div className="space-y-1.5 pt-2">
      <Progress
        value={held.current}
        // Unconditional, because this progressbar has never exposed a value to
        // assistive tech: `Progress` destructures `value` out and uses it only
        // for the indicator transform, so Radix's Root always sees its default
        // of null and never emits aria-valuenow. `label` already reads "57%"
        // when determinate and names the phase when not, which is the same
        // signal the pulse gives everyone who can see it.
        // Radix computes its own aria-valuenow from a `value` this component
        // never forwards, and the caller spread wins, so this is where a
        // determinate position can come from. Omitted while indeterminate,
        // where asserting a position would be a lie the pulse is not telling.
        aria-valuenow={percent !== null ? Math.round(held.current) : undefined}
        aria-valuetext={label}
        className={percent === null ? "animate-pulse" : undefined}
      />
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
