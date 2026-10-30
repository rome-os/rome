import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  type CloudInstance,
  type CloudState,
  errorMessage,
  romeApi,
  type RuntimeStatus,
} from "@/lib/rome-api";
import { cn } from "@/lib/utils";

/**
 * The main window's page while a Rome Cloud Rome is not open yet: sign in,
 * pick one when there are several, or wait on Rome Cloud. Main drives the
 * state; this page renders it and forwards the user's choice.
 */
export function RemoteWelcome({ status }: { status: RuntimeStatus }) {
  const [cloud, setCloud] = useState<CloudState | null>(null);
  const [busy, setBusy] = useState<"sign-in" | "choose" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    romeApi.cloud.getState().then(setCloud).catch(console.error);
  }, [status.primaryAction]);

  const signIn = useCallback(async () => {
    setError(null);
    setBusy("sign-in");
    try {
      await romeApi.cloud.signIn();
      await romeApi.runtime.ensureReady();
    } catch (err) {
      const message = errorMessage(err);
      if (!/cancelled/i.test(message)) setError(message);
    } finally {
      setBusy(null);
    }
  }, []);

  const working = status.primaryAction === "none" && status.phase !== "ready";
  const waitingOnBrowser = busy === "sign-in";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          {working && <Loader2 className="size-5 animate-spin text-muted-foreground" />}
          {waitingOnBrowser ? "Continue in your browser" : status.title}
        </h1>
        <p
          className={cn(
            "text-sm",
            status.phase === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {waitingOnBrowser
            ? "Approve Rome in the Rome Cloud tab that just opened, then come back here."
            : status.detail}
        </p>
      </div>

      {status.primaryAction === "sign_in" && (
        <div className="flex flex-col gap-3">
          <Button
            className="w-full"
            disabled={waitingOnBrowser}
            onClick={() => {
              signIn().catch(console.error);
            }}
          >
            {waitingOnBrowser && <Loader2 className="animate-spin" />}
            {waitingOnBrowser ? "Waiting for Rome Cloud…" : "Sign in with Rome Cloud"}
          </Button>
          {waitingOnBrowser && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => {
                romeApi.cloud.cancelSignIn().catch(console.error);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {status.primaryAction === "choose_instance" && (
        <InstanceChooser
          busy={busy === "choose"}
          onChoose={async (id) => {
            setError(null);
            setBusy("choose");
            try {
              await romeApi.runtime.chooseInstance(id);
            } catch (err) {
              setError(errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        />
      )}

      {status.primaryAction === "open_cloud" && (
        <div className="space-y-3">
          <Button
            className="w-full"
            onClick={() => {
              romeApi.runtime.openCloud().catch(console.error);
            }}
          >
            Open Rome Cloud
          </Button>
          <p className="text-center text-xs text-muted-foreground">Rome checks again on its own.</p>
        </div>
      )}

      {status.primaryAction === "retry" && (
        <Button
          className="w-full"
          onClick={() => {
            romeApi.runtime.ensureReady().catch(console.error);
          }}
        >
          Try again
        </Button>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {cloud?.signedIn && status.primaryAction !== "sign_in" && (
        <p className="text-center text-xs text-muted-foreground">
          Not your account?{" "}
          <button
            type="button"
            className="underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => {
              romeApi.cloud.signOut().catch((err) => setError(errorMessage(err)));
            }}
          >
            Sign out
          </button>
        </p>
      )}

      {cloud?.legacyRuntimeDir && (
        // Builds before this one could run a private Rome on this Mac. The app
        // no longer opens it, and never deletes it; this says where it is.
        <p className="border-t pt-4 text-xs text-muted-foreground">
          Your earlier Rome on this Mac no longer opens here. Its data stays in{" "}
          <span className="break-all">{cloud.legacyRuntimeDir}</span>.
        </p>
      )}
    </div>
  );
}

function InstanceChooser({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose: (id: string) => Promise<void>;
}) {
  const [instances, setInstances] = useState<CloudInstance[] | null>(null);

  useEffect(() => {
    romeApi.cloud.listInstances().then(setInstances).catch(console.error);
  }, []);

  if (!instances) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading your Romes…
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {instances.map((instance) => (
        <button
          key={instance.id}
          type="button"
          disabled={busy}
          onClick={() => {
            onChoose(instance.id).catch(console.error);
          }}
          className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-muted/40 disabled:opacity-50"
        >
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium">{instance.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{instance.origin}</span>
          </span>
          <Badge variant={instance.status === "running" ? "success" : "secondary"}>
            {instance.status}
          </Badge>
          <ChevronRight className="size-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}
