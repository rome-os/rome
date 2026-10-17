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
  const [busy, setBusy] = useState<"sign-in" | "choose" | "local" | null>(null);
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

  const useLocalVm = useCallback(async () => {
    setError(null);
    setBusy("local");
    try {
      await romeApi.runtime.setTarget({ kind: "local" });
    } catch (err) {
      setError(errorMessage(err));
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
              romeApi.runtime.openInstallPage().catch(console.error);
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

      <Advanced
        localVm={cloud?.localVm ?? null}
        busy={busy === "local"}
        onUseLocalVm={() => {
          useLocalVm().catch(console.error);
        }}
      />
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

/**
 * The private VM is for people who want Rome to run on this Mac. It is a
 * separate Rome, so the copy says so before anyone downloads gigabytes
 * expecting to see their Rome Cloud chats.
 */
function Advanced({
  localVm,
  busy,
  onUseLocalVm,
}: {
  localVm: CloudState["localVm"] | null;
  busy: boolean;
  onUseLocalVm: () => void;
}) {
  return (
    <details className="group border-t pt-4">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        Advanced
      </summary>
      <div className="mt-3 space-y-3 rounded-md border p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Run a private Rome on this Mac</p>
          <p className="text-xs text-muted-foreground">
            A separate Rome in a Linux VM on this computer. It does not share chats, memory, or apps
            with your Rome Cloud Rome. The first start downloads a few GB.
          </p>
        </div>
        {localVm && !localVm.supported && (
          <p className="text-xs text-destructive">{localVm.reason}</p>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !localVm?.supported}
          onClick={onUseLocalVm}
        >
          {busy && <Loader2 className="animate-spin" />}
          Use a private VM
        </Button>
      </div>
    </details>
  );
}
