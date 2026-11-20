import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Power,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Badge, type BadgeProps } from "@rome-os/ui/badge";
import { Button } from "@rome-os/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@rome-os/ui/card";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rome-os/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel, FormError } from "@rome-os/ui/field";
import { Input } from "@rome-os/ui/input";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@rome-os/ui/list-row";
import { Spinner } from "@rome-os/ui/spinner";
import { Switch } from "@rome-os/ui/switch";
import { api } from "../api";
import { formatBytes, formatDuration, type Messages } from "../i18n";
import type { HostPhase, HostSnapshot } from "../types";

export interface OverviewViewProps {
  t: Messages;
  snapshot: HostSnapshot;
  onSnapshot: (next: HostSnapshot) => void;
}

export function phaseBadgeVariant(phase: HostPhase): BadgeProps["variant"] {
  switch (phase) {
    case "online":
      return "success";
    case "authorizing":
    case "connecting":
    case "retrying":
      return "warning";
    case "revoked":
    case "superseded":
    case "error":
      return "destructive";
    default:
      return "muted";
  }
}

export function OverviewView({ t, snapshot, onSnapshot }: OverviewViewProps) {
  const [deviceName, setDeviceName] = useState(snapshot.deviceName);
  const [cloudUrl, setCloudUrl] = useState(snapshot.cloudUrl);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setDeviceName((prev) => (prev.trim() === "" ? snapshot.deviceName : prev));
  }, [snapshot.deviceName]);

  useEffect(() => {
    setCloudUrl((prev) => (prev.trim() === "" ? snapshot.cloudUrl : prev));
  }, [snapshot.cloudUrl]);

  async function runAction(name: string, fn: () => Promise<HostSnapshot>) {
    setBusyAction(name);
    setActionError(null);
    try {
      const next = await fn();
      onSnapshot(next);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  function handleStartAuthorize(event: FormEvent) {
    event.preventDefault();
    void runAction("authorize", () =>
      api.authorize({
        cloudUrl: cloudUrl.trim() || snapshot.cloudUrl,
        name: deviceName.trim() || snapshot.deviceName,
      }),
    );
  }

  async function handleCopyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // Clipboard API may be unavailable on non-secure origins.
    }
  }

  const pending = snapshot.pendingAuth;
  const remainingMs = pending ? pending.expiresAt - now : 0;
  const isConnectedOrActive =
    snapshot.phase === "online" || snapshot.phase === "connecting" || snapshot.phase === "retrying";
  const auditOk = snapshot.audit.summary.status.state === "ok";
  const showAuthorizeForm = !snapshot.configured || snapshot.phase === "revoked";

  return (
    <div className="space-y-6">
      {snapshot.phase === "revoked" ? (
        <Alert variant="destructive">
          <ShieldAlert />
          <AlertTitle>{t.phase.revoked}</AlertTitle>
          <AlertDescription>{t.overview.revokedNotice}</AlertDescription>
        </Alert>
      ) : null}

      {snapshot.phase === "superseded" ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>{t.phase.superseded}</AlertTitle>
          <AlertDescription>{t.overview.supersededNotice}</AlertDescription>
        </Alert>
      ) : null}

      {snapshot.lastError && snapshot.phase !== "revoked" && snapshot.phase !== "superseded" ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t.phase.error}</AlertTitle>
          <AlertDescription>{snapshot.lastError}</AlertDescription>
        </Alert>
      ) : null}

      {!auditOk ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t.audit.unavailableTitle}</AlertTitle>
          <AlertDescription>
            {snapshot.audit.summary.status.state === "unavailable"
              ? `${snapshot.audit.summary.status.message} — ${t.audit.unavailableHint}`
              : t.audit.unavailableHint}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.overview.statusTitle}</CardTitle>
            <CardDescription>{t.overview.statusDescription}</CardDescription>
            <CardAction>
              <Badge variant={phaseBadgeVariant(snapshot.phase)}>{t.phase[snapshot.phase]}</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="px-0">
            <List>
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.overview.uptime}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-ui tabular-nums text-foreground">
                  {formatDuration(Math.max(0, now - snapshot.since))}
                </span>
              </ListRow>
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.overview.deviceName}</ListRowDescription>
                </ListRowContent>
                <span className="truncate text-ui text-foreground">{snapshot.deviceName}</span>
              </ListRow>
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.overview.deviceId}</ListRowDescription>
                </ListRowContent>
                <span className="truncate font-mono text-aux text-foreground">
                  {snapshot.deviceId ?? t.overview.notLinked}
                </span>
              </ListRow>
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.overview.cloudOrigin}</ListRowDescription>
                </ListRowContent>
                <span className="truncate font-mono text-aux text-foreground">
                  {snapshot.cloudUrl}
                </span>
              </ListRow>
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.overview.platform}</ListRowDescription>
                </ListRowContent>
                <span className="font-mono text-aux text-foreground">
                  {snapshot.platform}
                  {snapshot.version ? ` · v${snapshot.version}` : ""}
                </span>
              </ListRow>
              <ListRow size="sm">
                <ListRowContent>
                  <ListRowDescription>{t.overview.auditState}</ListRowDescription>
                </ListRowContent>
                <div className="flex items-center gap-2">
                  <Badge variant={auditOk ? "success" : "destructive"}>
                    {auditOk ? t.overview.auditOk : t.overview.auditUnavailable}
                  </Badge>
                  <span className="text-aux tabular-nums text-muted-foreground">
                    {formatBytes(snapshot.audit.summary.bytes)} · {snapshot.audit.summary.requests}
                  </span>
                </div>
              </ListRow>
            </List>
          </CardContent>
        </Card>

        {pending ? (
          <Card>
            <CardHeader>
              <CardTitle>{t.overview.authorizeTitle}</CardTitle>
              <CardDescription>{t.overview.verificationHint}</CardDescription>
              <CardAction>
                <Badge variant="warning">{t.phase.authorizing}</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-12 border border-border bg-surface-muted p-4 text-center">
                <div className="text-aux text-muted-foreground">{t.overview.userCodeLabel}</div>
                <div className="mt-1 font-mono text-title tracking-widest text-foreground select-all">
                  {pending.userCode}
                </div>
                <div className="mt-2 text-aux tabular-nums text-muted-foreground">
                  {remainingMs > 0
                    ? t.overview.expiresIn(formatDuration(remainingMs))
                    : t.overview.expired}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="md">
                  <a
                    href={pending.verificationUriComplete}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    <ExternalLink data-icon="inline-start" />
                    {t.overview.openVerification}
                  </a>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  onClick={() => void handleCopyCode(pending.userCode)}
                >
                  {copiedCode ? (
                    <Check data-icon="inline-start" />
                  ) : (
                    <Copy data-icon="inline-start" />
                  )}
                  {copiedCode ? t.overview.copied : t.overview.copyCode}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  disabled={busyAction !== null}
                  onClick={() => void runAction("cancel", () => api.cancelAuthorize())}
                >
                  {t.overview.cancelAuth}
                </Button>
              </div>
              {actionError ? <FormError>{actionError}</FormError> : null}
            </CardContent>
          </Card>
        ) : showAuthorizeForm ? (
          <Card>
            <CardHeader>
              <CardTitle>{t.overview.authorizeTitle}</CardTitle>
              <CardDescription>{t.overview.authorizeDescription}</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleStartAuthorize} className="space-y-4">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="rome-node-device-name">
                      {t.overview.deviceNameLabel}
                    </FieldLabel>
                    <Input
                      id="rome-node-device-name"
                      size="md"
                      value={deviceName}
                      onChange={(e) => setDeviceName(e.target.value)}
                      disabled={busyAction !== null}
                    />
                    <FieldDescription>{t.overview.deviceNameHint}</FieldDescription>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="rome-node-cloud-url">
                      {t.overview.cloudUrlLabel}
                    </FieldLabel>
                    <Input
                      id="rome-node-cloud-url"
                      size="md"
                      type="url"
                      value={cloudUrl}
                      onChange={(e) => setCloudUrl(e.target.value)}
                      disabled={busyAction !== null}
                    />
                    <FieldDescription>{t.overview.cloudUrlHint}</FieldDescription>
                  </Field>
                </FieldGroup>
                {actionError ? <FormError>{actionError}</FormError> : null}
                <Button type="submit" size="md" disabled={busyAction !== null}>
                  {busyAction === "authorize" ? (
                    <Spinner size="sm" data-icon="inline-start" />
                  ) : (
                    <Link2 data-icon="inline-start" />
                  )}
                  {busyAction === "authorize"
                    ? t.overview.startingAuth
                    : snapshot.phase === "revoked"
                      ? t.overview.reauthorize
                      : t.overview.startAuth}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t.overview.controlsTitle}</CardTitle>
              <CardDescription>{t.overview.controlsDescription}</CardDescription>
            </CardHeader>
            <CardContent className="px-0">
              <List>
                <ListRow size="md">
                  <ListRowContent>
                    <ListRowTitle>{t.overview.executionLabel}</ListRowTitle>
                    <ListRowDescription>
                      {snapshot.executionEnabled
                        ? t.overview.executionOnHint
                        : t.overview.executionOffHint}
                    </ListRowDescription>
                  </ListRowContent>
                  <Switch
                    aria-label={t.overview.executionLabel}
                    checked={snapshot.executionEnabled}
                    disabled={busyAction !== null}
                    onCheckedChange={(checked) => {
                      void runAction("execution", () => api.setExecution(checked));
                    }}
                  />
                </ListRow>
                <ListRow size="md">
                  <ListRowContent>
                    <ListRowTitle>{t.overview.resetTitle}</ListRowTitle>
                    <ListRowDescription>{t.overview.resetDescription}</ListRowDescription>
                  </ListRowContent>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => setResetDialogOpen(true)}
                  >
                    <Trash2 data-icon="inline-start" />
                    {t.overview.resetButton}
                  </Button>
                </ListRow>
              </List>
              {actionError ? (
                <div className="px-4 pt-3">
                  <FormError>{actionError}</FormError>
                </div>
              ) : null}
            </CardContent>
            <CardFooter className="border-t border-border-subtle">
              {isConnectedOrActive ? (
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  disabled={busyAction !== null}
                  onClick={() => void runAction("disconnect", () => api.disconnect())}
                >
                  {busyAction === "disconnect" ? (
                    <Spinner size="sm" data-icon="inline-start" />
                  ) : (
                    <Power data-icon="inline-start" />
                  )}
                  {t.overview.disconnect}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="md"
                  disabled={busyAction !== null}
                  onClick={() => void runAction("connect", () => api.connect())}
                >
                  {busyAction === "connect" ? (
                    <Spinner size="sm" data-icon="inline-start" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  {snapshot.phase === "superseded" ? t.overview.reconnect : t.overview.connect}
                </Button>
              )}
            </CardFooter>
          </Card>
        )}
      </div>

      <Dialog open={resetDialogOpen} onClose={() => setResetDialogOpen(false)} modal size="sm">
        <DialogHeader onClose={() => setResetDialogOpen(false)}>
          <DialogTitle>{t.overview.resetDialogTitle}</DialogTitle>
          <DialogDescription>{t.overview.resetDialogBody}</DialogDescription>
        </DialogHeader>
        <DialogBody />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="md"
            onClick={() => setResetDialogOpen(false)}
          >
            {t.overview.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="md"
            disabled={busyAction !== null}
            onClick={() => {
              setResetDialogOpen(false);
              void runAction("reset", () => api.clearCredentials());
            }}
          >
            {t.overview.resetConfirm}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
