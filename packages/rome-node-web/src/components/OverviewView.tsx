import { useEffect, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  Power,
  RefreshCw,
  ScrollText,
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
import type { AuthSession, HostPhase, HostSnapshot, PasswordSource } from "../types";

export interface OverviewViewProps {
  t: Messages;
  snapshot: HostSnapshot;
  onSnapshot: (next: HostSnapshot) => void;
  passwordSource: PasswordSource;
  canRemovePassword: boolean;
  onSessionChange: (next: AuthSession) => void;
  onOpenLog?: () => void;
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

export function OverviewView({
  t,
  snapshot,
  onSnapshot,
  passwordSource,
  canRemovePassword,
  onSessionChange,
  onOpenLog,
}: OverviewViewProps) {
  const [deviceName, setDeviceName] = useState(snapshot.deviceName);
  const [cloudUrl, setCloudUrl] = useState(snapshot.cloudUrl);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [passwordDialog, setPasswordDialog] = useState<"set" | "remove" | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
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

  function openPasswordDialog(mode: "set" | "remove") {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
    setPasswordDialog(mode);
  }

  function closePasswordDialog() {
    if (passwordBusy) return;
    setPasswordDialog(null);
    setPasswordError(null);
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
  }

  async function handleSavePassword(event: FormEvent) {
    event.preventDefault();
    if (passwordSource === "file" && !currentPassword) {
      setPasswordError(t.password.currentRequired);
      return;
    }
    if (newPassword.length < 6 || newPassword.trim().length === 0) {
      setPasswordError(t.password.tooShort);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError(t.password.mismatch);
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      const nextSession = await api.setPassword({
        currentPassword: passwordSource === "file" ? currentPassword : undefined,
        newPassword,
      });
      onSessionChange(nextSession);
      setPasswordDialog(null);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleRemovePassword(event: FormEvent) {
    event.preventDefault();
    if (!currentPassword) {
      setPasswordError(t.password.currentRequired);
      return;
    }
    setPasswordBusy(true);
    setPasswordError(null);
    try {
      const nextSession = await api.removePassword(currentPassword);
      onSessionChange(nextSession);
      setPasswordDialog(null);
      setCurrentPassword("");
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : String(err));
    } finally {
      setPasswordBusy(false);
    }
  }

  const pending = snapshot.pendingAuth;
  const remainingMs = pending ? pending.expiresAt - now : 0;
  const isConnectedOrActive =
    snapshot.phase === "online" || snapshot.phase === "connecting" || snapshot.phase === "retrying";
  const auditOk = snapshot.audit.status.state === "ok";
  const showAuthorizeForm = !snapshot.configured || snapshot.phase === "revoked";
  const cloudDashboardUrl = `${snapshot.cloudUrl.replace(/\/+$/, "")}/dashboard`;

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
          <AlertTitle>{t.overview.auditUnavailableTitle}</AlertTitle>
          <AlertDescription>
            {snapshot.audit.status.state === "unavailable"
              ? `${snapshot.audit.status.message} — ${t.overview.auditUnavailableHint}`
              : t.overview.auditUnavailableHint}
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
                    {formatBytes(snapshot.audit.bytes)} · {snapshot.audit.requests}
                  </span>
                </div>
              </ListRow>
            </List>
          </CardContent>
          {onOpenLog || snapshot.configured ? (
            <CardFooter className="flex-wrap justify-between gap-2 border-t border-border-subtle">
              <span className="text-aux text-muted-foreground">{t.overview.auditCloudHint}</span>
              <div className="flex flex-wrap items-center gap-2">
                {onOpenLog ? (
                  <Button type="button" variant="outline" size="sm" onClick={onOpenLog}>
                    <ScrollText data-icon="inline-start" />
                    {t.overview.viewLog}
                  </Button>
                ) : null}
                {snapshot.configured ? (
                  <Button asChild variant="outline" size="sm">
                    <a href={cloudDashboardUrl} target="_blank" rel="noreferrer noopener">
                      <ExternalLink data-icon="inline-start" />
                      {t.overview.openCloud}
                    </a>
                  </Button>
                ) : null}
              </div>
            </CardFooter>
          ) : null}
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

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{t.password.title}</CardTitle>
            <Badge variant={passwordSource === "none" ? "muted" : "success"}>
              {passwordSource === "env"
                ? t.password.badgeEnv
                : passwordSource === "file"
                  ? t.password.badgeFile
                  : t.password.badgeNone}
            </Badge>
          </div>
          <CardDescription>
            {passwordSource === "env"
              ? t.password.descriptionEnv
              : passwordSource === "file"
                ? t.password.descriptionFile
                : t.password.descriptionNone}
          </CardDescription>
          {passwordSource !== "env" ? (
            <CardAction>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => openPasswordDialog("set")}
                >
                  <KeyRound data-icon="inline-start" />
                  {passwordSource === "file" ? t.password.changeButton : t.password.setButton}
                </Button>
                {passwordSource === "file" && canRemovePassword ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openPasswordDialog("remove")}
                  >
                    {t.password.removeButton}
                  </Button>
                ) : null}
              </div>
            </CardAction>
          ) : null}
        </CardHeader>
      </Card>

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

      <Dialog open={passwordDialog === "set"} onClose={closePasswordDialog} modal size="sm">
        <form onSubmit={handleSavePassword}>
          <DialogHeader onClose={closePasswordDialog}>
            <DialogTitle>
              {passwordSource === "file" ? t.password.changeDialogTitle : t.password.setDialogTitle}
            </DialogTitle>
            <DialogDescription>
              {passwordSource === "file"
                ? t.password.changeDialogDescription
                : t.password.setDialogDescription}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FieldGroup>
              {passwordSource === "file" ? (
                <Field>
                  <FieldLabel htmlFor="rome-node-current-password">
                    {t.password.currentLabel}
                  </FieldLabel>
                  <Input
                    id="rome-node-current-password"
                    type="password"
                    autoComplete="current-password"
                    size="md"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    disabled={passwordBusy}
                  />
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="rome-node-new-password">{t.password.newLabel}</FieldLabel>
                <Input
                  id="rome-node-new-password"
                  type="password"
                  autoComplete="new-password"
                  size="md"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={passwordBusy}
                />
                <FieldDescription>{t.password.minLengthHint}</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="rome-node-confirm-password">
                  {t.password.confirmLabel}
                </FieldLabel>
                <Input
                  id="rome-node-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  size="md"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={passwordBusy}
                />
              </Field>
            </FieldGroup>
            {passwordError ? (
              <div className="mt-3">
                <FormError>{passwordError}</FormError>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="md"
              disabled={passwordBusy}
              onClick={closePasswordDialog}
            >
              {t.overview.cancel}
            </Button>
            <Button type="submit" size="md" disabled={passwordBusy}>
              {passwordBusy ? <Spinner size="sm" data-icon="inline-start" /> : null}
              {passwordBusy ? t.password.saving : t.password.save}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog open={passwordDialog === "remove"} onClose={closePasswordDialog} modal size="sm">
        <form onSubmit={handleRemovePassword}>
          <DialogHeader onClose={closePasswordDialog}>
            <DialogTitle>{t.password.removeDialogTitle}</DialogTitle>
            <DialogDescription>{t.password.removeDialogDescription}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field>
              <FieldLabel htmlFor="rome-node-remove-password">{t.password.currentLabel}</FieldLabel>
              <Input
                id="rome-node-remove-password"
                type="password"
                autoComplete="current-password"
                size="md"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                disabled={passwordBusy}
              />
            </Field>
            {passwordError ? (
              <div className="mt-3">
                <FormError>{passwordError}</FormError>
              </div>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="md"
              disabled={passwordBusy}
              onClick={closePasswordDialog}
            >
              {t.overview.cancel}
            </Button>
            <Button type="submit" variant="destructive" size="md" disabled={passwordBusy}>
              {passwordBusy ? <Spinner size="sm" data-icon="inline-start" /> : null}
              {passwordBusy ? t.password.removing : t.password.removeConfirm}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </div>
  );
}
