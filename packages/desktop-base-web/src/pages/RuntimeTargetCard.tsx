import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  type CloudInstance,
  type CloudState,
  type DeviceStatus,
  errorMessage,
  romeApi,
  type RuntimeTarget,
} from "@/lib/rome-api";
import { cn } from "@/lib/utils";

type Busy = "sign-in" | "sign-out" | "list" | "save" | null;

function sameTarget(a: RuntimeTarget, b: RuntimeTarget): boolean {
  if (a.kind === "local" || b.kind === "local") return a.kind === b.kind;
  return (a.instance?.id ?? null) === (b.instance?.id ?? null);
}

function deviceLine(device: DeviceStatus): string | null {
  switch (device.state) {
    case "connected":
      return `This Mac is connected as ${device.name}. Your Rome can run programs on it.`;
    case "connecting":
      return "Connecting this Mac…";
    case "offline":
      return "This Mac is not connected.";
    case "disabled":
      return "Rome can't use this Mac. Turn it on in your Rome under Settings → Devices.";
    case "off":
      return null;
  }
}

function OptionRow({
  checked,
  onSelect,
  title,
  detail,
  trailing,
  disabled,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  trailing?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
        checked ? "border-foreground/40 bg-muted/50" : "hover:bg-muted/30",
        disabled && "opacity-50",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked && "border-foreground",
        )}
      >
        {checked && <span className="size-2 rounded-full bg-foreground" />}
      </span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {trailing}
    </button>
  );
}

/**
 * Picks the Rome the app opens: the VM on this computer, or a hosted Rome from
 * the user's Rome Cloud account. Saving restarts the app, which is when the
 * choice takes effect.
 */
export function RuntimeTargetCard() {
  const [cloud, setCloud] = useState<CloudState | null>(null);
  const [instances, setInstances] = useState<CloudInstance[] | null>(null);
  const [kind, setKind] = useState<RuntimeTarget["kind"]>("local");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);

  const loadInstances = useCallback(async () => {
    setBusy("list");
    try {
      setInstances(await romeApi.cloud.listInstances());
    } catch (err) {
      setInstances(null);
      setError(errorMessage(err));
      // A rejected credential is forgotten in main; show the sign-in again.
      setCloud(await romeApi.cloud.getState());
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(
    () =>
      romeApi.on("device:status", (device) => {
        setCloud((state) => (state ? { ...state, device } : state));
      }),
    [],
  );

  useEffect(() => {
    romeApi.cloud
      .getState()
      .then((state) => {
        setCloud(state);
        setKind(state.savedTarget.kind);
        if (state.savedTarget.kind === "remote") {
          setSelectedId(state.savedTarget.instance?.id ?? null);
        }
        if (state.signedIn) void loadInstances();
      })
      .catch((err) => setError(errorMessage(err)));
  }, [loadInstances]);

  const handleSignIn = useCallback(async () => {
    setError(null);
    setBusy("sign-in");
    try {
      const state = await romeApi.cloud.signIn();
      setCloud(state);
      setBusy(null);
      await loadInstances();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }, [loadInstances]);

  const handleSignOut = useCallback(async () => {
    setError(null);
    setBusy("sign-out");
    try {
      const state = await romeApi.cloud.signOut();
      setCloud(state);
      setInstances(null);
      setSelectedId(null);
      setKind("local");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }, []);

  const selected = instances?.find((instance) => instance.id === selectedId) ?? null;
  // Rome Cloud with nothing picked is allowed: the app opens on its welcome
  // screen and signs in or picks there.
  const target: RuntimeTarget =
    kind === "local"
      ? { kind: "local" }
      : {
          kind: "remote",
          instance: selected
            ? { id: selected.id, name: selected.name, origin: selected.origin }
            : null,
        };
  const changed = !!cloud && !sameTarget(target, cloud.activeTarget);

  const handleSave = useCallback(async () => {
    setError(null);
    setBusy("save");
    try {
      // In place on the welcome screen; otherwise the app relaunches and this
      // window goes with it.
      if ((await romeApi.runtime.setTarget(target)) === "switched") {
        setCloud(await romeApi.cloud.getState());
        setBusy(null);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  }, [target]);

  // Only a Rome Cloud launch connects this computer.
  const deviceText = cloud?.activeTarget.kind === "remote" ? deviceLine(cloud.device) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where Rome runs</CardTitle>
        <CardDescription>Rome restarts to switch.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div role="radiogroup" aria-label="Where Rome runs" className="space-y-2">
          <OptionRow
            checked={kind === "remote"}
            onSelect={() => setKind("remote")}
            disabled={cloud?.available === false}
            title="Rome Cloud"
            detail="Open a Rome hosted in your Rome Cloud account."
          />
          <OptionRow
            checked={kind === "local"}
            onSelect={() => setKind("local")}
            disabled={cloud?.localVm.supported === false}
            title="A private VM on this Mac"
            detail="A separate Rome that runs on this computer."
          />
        </div>

        {kind === "remote" && cloud && !cloud.signedIn && (
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              disabled={busy === "sign-in"}
              onClick={() => {
                handleSignIn().catch(console.error);
              }}
            >
              {busy === "sign-in" && <Loader2 className="animate-spin" />}
              {busy === "sign-in" ? "Waiting for your browser…" : "Sign in to Rome Cloud"}
            </Button>
            {busy === "sign-in" && (
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

        {kind === "remote" && cloud?.signedIn && (
          <div className="space-y-2">
            {busy === "list" && !instances && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Loading your Romes…
              </p>
            )}
            {instances?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                There is no Rome in your Rome Cloud account yet.
              </p>
            )}
            {instances && instances.length > 0 && (
              <div role="radiogroup" aria-label="Your Romes" className="space-y-2">
                {instances.map((instance) => (
                  <OptionRow
                    key={instance.id}
                    checked={selectedId === instance.id}
                    onSelect={() => setSelectedId(instance.id)}
                    title={instance.name}
                    detail={instance.origin}
                    trailing={
                      <Badge variant={instance.status === "running" ? "success" : "secondary"}>
                        {instance.status}
                      </Badge>
                    }
                  />
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Signed in to {cloud.cloudOrigin ? new URL(cloud.cloudOrigin).host : "Rome Cloud"} ·{" "}
              <button
                type="button"
                className="underline-offset-2 hover:text-foreground hover:underline"
                disabled={busy !== null}
                onClick={() => {
                  handleSignOut().catch(console.error);
                }}
              >
                Sign out
              </button>
            </p>
            {deviceText && <p className="text-xs text-muted-foreground">{deviceText}</p>}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Separator />

        <div className="flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            {cloud && !sameTarget(cloud.savedTarget, cloud.activeTarget)
              ? "A saved change applies when Rome restarts."
              : cloud?.activeTarget.kind === "remote"
                ? cloud.activeTarget.instance
                  ? `Now using ${cloud.activeTarget.instance.name}.`
                  : "Now on Rome Cloud sign-in."
                : "Now using the private VM."}
          </p>
          <Button
            size="sm"
            disabled={!changed || busy !== null}
            onClick={() => {
              handleSave().catch(console.error);
            }}
          >
            {busy === "save" && <Loader2 className="animate-spin" />}
            Save and restart
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
