import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { Globe, Lock, Mail, X } from "lucide-react";
import type {
  AppAccessMode,
  AppInstallResponse,
  AppPublishResponse,
  InstalledAppCard,
  SpecSource,
} from "@rome/api-types/apps";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldDescription, FieldLabel } from "@/components/ui/field";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { RomeConfirmDialog } from "@/components/rome-confirm-dialog";
import { parseEmailTextarea } from "@/lib/email-list";
import { fetchJson } from "@/lib/fetch-json";
import { useInvalidateApps, useUpgradeCandidates, type UpgradeCandidate } from "@/hooks/use-apps";

// Every app lifecycle write (upgrade, enable/disable, uninstall, publish,
// public access) plus the confirm/access dialogs they need, shared by the
// apps grid and the app details page so both surfaces drive the exact same
// mutations and re-read server truth the same way.
//
// Error surfacing is a toast, not per-card inline state: the launcher tiles
// have no room for an error strip, and a toast reads the same from both
// surfaces. Persistent install errors (`app.error` from the server) are a
// separate concern rendered by the details page.

interface PublicAccessConfigPayload {
  enableAccessControl: boolean;
  allowedApps: string[];
  cloudEmailAccess: Record<string, string[]>;
}

interface UninstallTarget {
  app: InstalledAppCard;
  purge: boolean;
}

export interface UpgradeTarget {
  app: InstalledAppCard;
  candidate: UpgradeCandidate;
}

export interface AppLifecycle {
  /** True while any lifecycle write (single or bulk) is in flight. */
  lifecycleBusy: boolean;
  /** True while the public-access write is in flight (tracked separately). */
  accessBusy: boolean;
  bulkUpgradePending: boolean;
  isAppActing: (id: string) => boolean;
  /** The in-flight verb for this app ("Uninstalling…", "Enabling…"), or null. */
  actingLabelFor: (app: InstalledAppCard) => string | null;
  /** The app's upgrade candidate, dropped when stale vs the installed version. */
  freshCandidate: (app: InstalledAppCard) => UpgradeCandidate | undefined;
  upgradeTargets: UpgradeTarget[];
  toggle: (app: InstalledAppCard) => void;
  upgrade: (app: InstalledAppCard) => void;
  upgradeAll: () => void;
  requestUninstall: (app: InstalledAppCard, purge: boolean) => void;
  requestPublish: (app: InstalledAppCard) => void;
  requestAccess: (app: InstalledAppCard) => void;
  startChatToUpdate: (app: InstalledAppCard) => void;
  /** Render once per page — the uninstall/publish confirms and access dialog. */
  dialogs: ReactNode;
}

export function useAppLifecycle(
  apps: InstalledAppCard[] | null,
  options?: {
    /**
     * false = read upgrade candidates from the query cache without firing the
     * expensive updates probe (the details-page contract).
     */
    probeUpdates?: boolean;
    /** Called after a successful uninstall (e.g. leave the details page). */
    onUninstalled?: (app: InstalledAppCard) => void;
  },
): AppLifecycle {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const invalidateApps = useInvalidateApps();
  const upgradable = useUpgradeCandidates({ probe: options?.probeUpdates !== false });
  const onUninstalled = options?.onUninstalled;

  const [actingAppId, setActingAppId] = useState<string | null>(null);
  // The verb shown while an app is acting ("Uninstalling…", "Enabling…").
  // Tracked alongside actingAppId because the optimistic acting window precedes
  // the server-reported phase, so callers can't derive the verb from app.phase.
  const [actingLabel, setActingLabel] = useState<string | null>(null);
  const [publicActionAppId, setPublicActionAppId] = useState<string | null>(null);
  const [bulkUpgradeAppIds, setBulkUpgradeAppIds] = useState<string[]>([]);
  const [uninstallTarget, setUninstallTarget] = useState<UninstallTarget | null>(null);
  const [publishTarget, setPublishTarget] = useState<InstalledAppCard | null>(null);
  const [accessTarget, setAccessTarget] = useState<InstalledAppCard | null>(null);
  const [accessModeDraft, setAccessModeDraft] = useState<AppAccessMode>("private");
  // The email allowlist draft: a committed list plus the input's pending text.
  // Both are local until "Save access" — the dialog's cancel/save contract —
  // unlike the settings page, which persists each add/remove immediately.
  const [accessEmailsDraft, setAccessEmailsDraft] = useState<string[]>([]);
  const [accessEmailInput, setAccessEmailInput] = useState("");
  const [accessDialogError, setAccessDialogError] = useState("");

  // Every lifecycle write follows the same shape: mark the app as acting, run
  // the request, toast any error, then invalidate the apps query so consumers
  // re-render from server truth (capabilities, upgrade candidates) rather than
  // a hand-merged guess. `onSuccess` returns the *list* invalidation promise so
  // the acting state persists until the authoritative refetch lands (avoiding a
  // flash of stale data) without blocking on the slow upgrade probe; that probe
  // is refreshed separately, and only for writes that can change upgrade
  // availability.
  const markActing = (id: string, label: string) => {
    setActingAppId(id);
    setActingLabel(label);
  };
  const clearActing = () => {
    setActingAppId(null);
    setActingLabel(null);
  };
  const toastError = (err: Error) => toast.error(err.message);

  // POST /apps — re-installs an installed app from a newer source (upgrade);
  // the daemon derives the app id from the source and returns it. `vars.id`
  // only keys the acting UI state.
  const installMutation = useMutation({
    mutationFn: (vars: { id: string; source: SpecSource; fallback: string }) =>
      fetchJson<AppInstallResponse>("/api/apps", {
        method: "POST",
        json: { source: vars.source },
        fallback: vars.fallback,
      }),
    onMutate: ({ id }) => markActing(id, t("installed.upgrading")),
    onError: (err) => toastError(err),
    // Install/upgrade can change upgrade availability: refresh the probe too,
    // but only await the list so acting clears without waiting on it.
    onSuccess: () => {
      void invalidateApps.updates();
      return invalidateApps.list();
    },
    onSettled: clearActing,
  });

  const toggleMutation = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean; fallback: string }) =>
      fetchJson<AppInstallResponse>(`/api/apps/${encodeURIComponent(vars.id)}`, {
        method: "PATCH",
        json: { enabled: vars.enabled },
        fallback: vars.fallback,
      }),
    onMutate: ({ id, enabled }) =>
      markActing(id, enabled ? t("toggle.enabling") : t("toggle.disabling")),
    onError: (err) => toastError(err),
    // Enable/disable can't change upgrade availability — list only.
    onSuccess: () => invalidateApps.list(),
    onSettled: clearActing,
  });

  const uninstallMutation = useMutation({
    mutationFn: (vars: { id: string; purge: boolean; fallback: string }) =>
      fetchJson<unknown>(`/api/apps/${encodeURIComponent(vars.id)}`, {
        method: "DELETE",
        json: { purge: vars.purge },
        fallback: vars.fallback,
      }),
    onMutate: ({ id }) => markActing(id, t("phase.uninstalling")),
    onError: (err) => toastError(err),
    // The removed app may have had an upgrade candidate; drop it so the header's
    // updates count doesn't keep advertising an update for an app that's gone.
    onSuccess: () => {
      void invalidateApps.updates();
      return invalidateApps.list();
    },
    onSettled: clearActing,
  });

  // POST /apps/:id/publish — repack the installed bundle and push it to the
  // App Store. Nothing changes locally on success (the published version equals
  // the installed one, so it can't become an upgrade candidate either) — no
  // query invalidation, just the acting state and toasts.
  const publishMutation = useMutation({
    mutationFn: (vars: { id: string; fallback: string }) =>
      fetchJson<AppPublishResponse>(`/api/apps/${encodeURIComponent(vars.id)}/publish`, {
        method: "POST",
        fallback: vars.fallback,
      }),
    onMutate: ({ id }) => markActing(id, t("installed.publishing")),
    onError: (err) => toastError(err),
    onSettled: clearActing,
  });

  const bulkUpgradeMutation = useMutation({
    mutationFn: async (targets: UpgradeTarget[]) => {
      let failed = 0;
      for (const { app, candidate } of targets) {
        try {
          await fetchJson<AppInstallResponse>("/api/apps", {
            method: "POST",
            json: { source: candidate.targetSource },
            fallback: t("installed.errors.upgradeFailed", { name: app.displayName }),
          });
        } catch {
          failed += 1;
        }
      }
      return { total: targets.length, failed };
    },
    onMutate: (targets) => setBulkUpgradeAppIds(targets.map(({ app }) => app.id)),
    onSuccess: (result) => {
      if (result.failed === 0) {
        toast.success(t("installed.updateAllSuccess", { count: result.total }));
      } else {
        toast.error(
          t("installed.updateAllPartial", {
            count: result.total,
            failed: result.failed,
            updated: result.total - result.failed,
          }),
        );
      }
      void invalidateApps.updates();
      return invalidateApps.list();
    },
    onSettled: () => setBulkUpgradeAppIds([]),
  });

  // Public/restricted access lives in a separate config endpoint: read the
  // current policy, update only this app's mode, write it back. Tracked by its
  // own acting id so it doesn't lock the install/toggle controls.
  const accessMutation = useMutation({
    mutationFn: async ({
      app,
      mode,
      emails,
    }: {
      app: InstalledAppCard;
      mode: AppAccessMode;
      emails: string[];
    }) => {
      const config = await fetchJson<PublicAccessConfigPayload>("/api/public-access", {
        fallback: t("installed.errors.publicAccessLoadFailed", { name: app.displayName }),
      });
      const allowedApps = new Set(Array.isArray(config.allowedApps) ? config.allowedApps : []);
      const cloudEmailAccess = { ...(config.cloudEmailAccess ?? {}) };
      allowedApps.delete(app.id);
      delete cloudEmailAccess[app.id];

      if (mode === "public") {
        allowedApps.add(app.id);
      } else if (mode === "cloud-email") {
        cloudEmailAccess[app.id] = emails;
      }

      await fetchJson<unknown>("/api/public-access", {
        method: "PUT",
        json: {
          enableAccessControl: config.enableAccessControl === true,
          allowedApps: Array.from(allowedApps).sort(),
          cloudEmailAccess,
        } satisfies PublicAccessConfigPayload,
        fallback: t("installed.errors.publicAccessUpdateFailed", { name: app.displayName }),
      });
    },
    onMutate: ({ app }) => setPublicActionAppId(app.id),
    // The access dialog surfaces its own inline error; no toast here.
    // Visibility change only — list reflects isPublic; no upgrade probe.
    onSuccess: () => invalidateApps.list(),
    onSettled: () => setPublicActionAppId(null),
  });

  const lifecycleBusy = actingAppId !== null || bulkUpgradeMutation.isPending;
  const accessBusy = publicActionAppId !== null;
  const isAppActing = (id: string): boolean => actingAppId === id || bulkUpgradeAppIds.includes(id);

  const actingLabelFor = (app: InstalledAppCard): string | null => {
    // Bulk upgrade tracks its own id set with no per-app verb; fall back to
    // the upgrade verb for those.
    if (bulkUpgradeAppIds.includes(app.id)) return t("installed.upgrading");
    return actingAppId === app.id ? actingLabel : null;
  };

  // The upgrade probe is cached for 5min and does not refetch on focus, so a
  // candidate can outlive the version it was computed against — e.g. an
  // out-of-band CLI upgrade lands while we're still holding the old probe. The
  // installed list refetches eagerly, so once the two disagree the candidate's
  // targetSource is unsafe to replay (an appstore candidate would downgrade).
  // Treat any version mismatch as stale and drop the candidate; the next
  // updates() invalidation cycle will refill it.
  const freshCandidate = (app: InstalledAppCard): UpgradeCandidate | undefined => {
    const candidate = upgradable[app.id];
    if (!candidate || candidate.currentVersion !== app.version) return undefined;
    return candidate;
  };

  const upgradeTargets: UpgradeTarget[] =
    apps
      ?.map((app) => {
        const candidate = freshCandidate(app);
        return candidate ? { app, candidate } : null;
      })
      .filter((target): target is UpgradeTarget => target !== null) ?? [];

  const toggleApp = async (app: InstalledAppCard) => {
    if (!app.canToggle || lifecycleBusy) return;
    const enabled = !app.isEnabled;
    const fallback = enabled
      ? t("installed.errors.toggleEnableFailed", { name: app.displayName })
      : t("installed.errors.toggleDisableFailed", { name: app.displayName });

    try {
      await toggleMutation.mutateAsync({ id: app.id, enabled, fallback });
    } catch {
      return; // Failure already surfaced via the mutation's onError toast.
    }

    if (!enabled) {
      const toastId = toast(t("installed.undoDisabled", { name: app.displayName }), {
        duration: 5000,
        action: {
          label: t("installed.undo"),
          onClick: () => {
            toast.dismiss(toastId);
            toggleMutation.mutate({
              id: app.id,
              enabled: true,
              fallback: t("installed.errors.toggleEnableFailed", { name: app.displayName }),
            });
          },
        },
      });
    }
  };

  const upgrade = (app: InstalledAppCard) => {
    if (lifecycleBusy) return;
    const candidate = freshCandidate(app);
    if (!candidate) return;
    installMutation.mutate({
      id: app.id,
      source: candidate.targetSource,
      fallback: t("installed.errors.upgradeFailed", { name: app.displayName }),
    });
  };

  const upgradeAll = () => {
    if (lifecycleBusy || accessBusy || upgradeTargets.length === 0) return;
    bulkUpgradeMutation.mutate(upgradeTargets);
  };

  const requestUninstall = (app: InstalledAppCard, purge: boolean) => {
    if (!app.canUninstall || lifecycleBusy) return;
    setUninstallTarget({ app, purge });
  };

  const confirmUninstall = () => {
    const target = uninstallTarget;
    if (!target) return;
    const { app, purge } = target;
    setUninstallTarget(null);
    uninstallMutation.mutate(
      {
        id: app.id,
        purge,
        fallback: t("installed.errors.uninstallFailed", { name: app.displayName }),
      },
      {
        onSuccess: () => {
          toast.success(
            t(purge ? "installed.uninstallPurgeSuccess" : "installed.uninstallSuccess", {
              name: app.displayName,
            }),
          );
          onUninstalled?.(app);
        },
      },
    );
  };

  const requestPublish = (app: InstalledAppCard) => {
    if (!app.canPublish || lifecycleBusy) return;
    setPublishTarget(app);
  };

  const confirmPublish = () => {
    const app = publishTarget;
    if (!app) return;
    setPublishTarget(null);
    publishMutation.mutate(
      {
        id: app.id,
        fallback: t("installed.errors.publishFailed", { name: app.displayName }),
      },
      {
        onSuccess: (result) =>
          toast.success(
            t("installed.publishSuccess", {
              name: app.displayName,
              version: result.version.version,
            }),
          ),
      },
    );
  };

  const requestAccess = (app: InstalledAppCard) => {
    if (!app.canManagePublicAccess || accessBusy || lifecycleBusy) return;
    setAccessTarget(app);
    setAccessModeDraft(app.accessMode ?? (app.isPublic ? "public" : "private"));
    setAccessEmailsDraft(app.cloudAllowedEmails ?? []);
    setAccessEmailInput("");
    setAccessDialogError("");
  };

  const cancelAccessDialog = () => {
    if (accessMutation.isPending) return;
    setAccessTarget(null);
    setAccessDialogError("");
  };

  // Moves the addresses in `raw` into the draft list. Valid ones are appended
  // (deduped); invalid ones stay in the input with an error so the user can
  // fix them. Returns the resulting list, or null while invalid tokens remain
  // so a save can block on them.
  const commitAccessEmails = (raw: string): string[] | null => {
    const parsed = parseEmailTextarea(raw);
    const seen = new Set(accessEmailsDraft);
    const added = parsed.emails.filter((email) => !seen.has(email));
    const next = added.length > 0 ? [...accessEmailsDraft, ...added] : accessEmailsDraft;
    if (added.length > 0) setAccessEmailsDraft(next);
    if (parsed.invalid.length > 0) {
      setAccessEmailInput(parsed.invalid.join(" "));
      setAccessDialogError(
        t("installed.accessDialog.invalidEmails", { emails: parsed.invalid.join(", ") }),
      );
      return null;
    }
    setAccessEmailInput("");
    setAccessDialogError("");
    return next;
  };

  const handleAccessEmailPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    commitAccessEmails(`${accessEmailInput} ${text}`);
  };

  const removeAccessEmail = (email: string) => {
    setAccessEmailsDraft((current) => current.filter((entry) => entry !== email));
  };

  const confirmAccessDialog = () => {
    const app = accessTarget;
    if (!app) return;
    let emails: string[] = [];
    if (accessModeDraft === "cloud-email") {
      // Text still sitting in the input counts: commit it so a typed-but-not-
      // added address is saved rather than silently dropped.
      const committed = commitAccessEmails(accessEmailInput);
      if (committed === null) return;
      if (committed.length === 0) {
        setAccessDialogError(t("installed.accessDialog.emptyEmails"));
        return;
      }
      emails = committed;
    }
    accessMutation.mutate(
      {
        app,
        mode: accessModeDraft,
        emails,
      },
      {
        onSuccess: () => setAccessTarget(null),
        onError: (err) =>
          setAccessDialogError(
            err instanceof Error ? err.message : t("installed.errors.publicAccessFailed"),
          ),
      },
    );
  };

  const startChatToUpdate = (app: InstalledAppCard) => {
    if (!app.projectPath) return;
    navigate("/chat", { state: { projectPath: app.projectPath } });
  };

  const uninstallDialogOpen = uninstallTarget !== null;
  const uninstallDialogTitle = uninstallTarget
    ? t("installed.uninstallDialog.title", { name: uninstallTarget.app.displayName })
    : "";
  const uninstallDialogDescription = uninstallTarget
    ? uninstallTarget.purge
      ? t("installed.uninstallDialog.descriptionPurge")
      : t("installed.uninstallDialog.descriptionKeep")
    : "";
  const uninstallDialogConfirm = uninstallTarget
    ? uninstallTarget.purge
      ? t("installed.uninstallDialog.confirmPurge")
      : t("installed.uninstallDialog.confirmKeep")
    : "";
  const accessDialogTitle = accessTarget
    ? t("installed.accessDialog.title", { name: accessTarget.displayName })
    : "";
  const accessSaving = accessMutation.isPending;

  const dialogs = (
    <>
      <RomeConfirmDialog
        open={uninstallDialogOpen}
        destructive
        title={uninstallDialogTitle}
        description={uninstallDialogDescription}
        confirmLabel={uninstallDialogConfirm}
        onCancel={() => setUninstallTarget(null)}
        onConfirm={confirmUninstall}
      />

      <RomeConfirmDialog
        open={publishTarget !== null}
        title={
          publishTarget
            ? t("installed.publishDialog.title", { name: publishTarget.displayName })
            : ""
        }
        description={
          publishTarget
            ? t("installed.publishDialog.description", { version: publishTarget.version })
            : ""
        }
        confirmLabel={publishTarget ? t("installed.publishDialog.confirm") : ""}
        onCancel={() => setPublishTarget(null)}
        onConfirm={confirmPublish}
      />

      <Dialog
        open={accessTarget !== null}
        onClose={cancelAccessDialog}
        ariaLabel={accessDialogTitle}
        size="md"
      >
        <DialogHeader onClose={accessSaving ? undefined : cancelAccessDialog}>
          <DialogTitle>{accessDialogTitle}</DialogTitle>
          <DialogDescription className="mt-1">
            {t("installed.accessDialog.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <RadioGroup
            aria-label={t("installed.access")}
            value={accessModeDraft}
            onValueChange={(next) => {
              setAccessModeDraft(next as AppAccessMode);
              setAccessDialogError("");
            }}
            disabled={accessSaving}
          >
            {[
              {
                mode: "private" as const,
                icon: Lock,
                title: t("installed.accessDialog.privateTitle"),
                description: t("installed.accessDialog.privateDescription"),
              },
              {
                mode: "public" as const,
                icon: Globe,
                title: t("installed.accessDialog.publicTitle"),
                description: t("installed.accessDialog.publicDescription"),
              },
              {
                mode: "cloud-email" as const,
                icon: Mail,
                title: t("installed.accessDialog.cloudEmailTitle"),
                description: t("installed.accessDialog.cloudEmailDescription"),
              },
            ].map((option) => {
              const Icon = option.icon;
              const id = `app-access-mode-${option.mode}`;
              return (
                // The card paint sits on the label and follows the radio's own
                // state, so what is highlighted can never disagree with what is
                // checked. The focus edge is on the card for the same reason it
                // used to be: roving focus lands on the checked option, so an
                // edge drawn only around the 16px circle inside an
                // already-highlighted card says almost nothing.
                <label
                  key={option.mode}
                  htmlFor={id}
                  className="flex min-h-20 items-start gap-3 rounded-8 border border-border bg-surface px-3 py-3 text-muted-foreground outline-1 outline-offset-0 outline-transparent transition-colors hover:border-border-strong hover:text-foreground has-data-[state=checked]:border-foreground has-data-[state=checked]:bg-surface-muted has-data-[state=checked]:text-foreground has-focus-visible:outline-solid has-focus-visible:outline-ring/50 has-disabled:opacity-60"
                >
                  <span className="flex h-5 shrink-0 items-center">
                    {/* The card already dims as a whole, and nested opacity
                        multiplies, so the item keeps its own full opacity
                        rather than landing at 30% inside a card at 60%. */}
                    <RadioGroupItem id={id} value={option.mode} className="disabled:opacity-100" />
                  </span>
                  <span className="flex h-5 shrink-0 items-center">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-ui">{option.title}</span>
                    <span className="mt-1 block text-aux text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </RadioGroup>

          {accessModeDraft === "cloud-email" ? (
            <div className="space-y-2">
              <FieldLabel htmlFor="app-access-emails">
                {t("installed.accessDialog.emailLabel")}
              </FieldLabel>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Input
                    id="app-access-emails"
                    size="md"
                    icon={<Mail />}
                    type="email"
                    value={accessEmailInput}
                    onChange={(event) => {
                      setAccessEmailInput(event.target.value);
                      if (accessDialogError) setAccessDialogError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      commitAccessEmails(accessEmailInput);
                    }}
                    onPaste={handleAccessEmailPaste}
                    disabled={accessSaving}
                    placeholder={t("installed.accessDialog.emailPlaceholder")}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={accessDialogError ? true : undefined}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  disabled={accessSaving || !accessEmailInput.trim()}
                  onClick={() => commitAccessEmails(accessEmailInput)}
                >
                  {t("installed.accessDialog.addEmail")}
                </Button>
              </div>
              <FieldDescription>{t("installed.accessDialog.emailHelp")}</FieldDescription>
              {accessEmailsDraft.length > 0 ? (
                <ul className="space-y-2 pt-2">
                  {accessEmailsDraft.map((email) => (
                    <li
                      key={email}
                      className="flex items-center gap-3 rounded-8 border border-border px-3 py-2"
                    >
                      <Avatar>
                        <AvatarFallback className="bg-primary/15 text-primary">
                          {email[0]?.toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                        {email}
                      </span>
                      <IconButton
                        size="sm"
                        label={t("installed.accessDialog.removeEmail", { email })}
                        icon={<X />}
                        className="text-muted-foreground hover:text-foreground"
                        disabled={accessSaving}
                        onClick={() => removeAccessEmail(email)}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 rounded-12 border border-dashed border-border px-3 py-3 text-ui text-muted-foreground">
                  {t("installed.accessDialog.emptyEmails")}
                </p>
              )}
            </div>
          ) : null}

          {accessDialogError ? (
            <p role="alert" className="text-ui text-destructive-fg">
              {accessDialogError}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={cancelAccessDialog}
            disabled={accessSaving}
          >
            {t("installed.accessDialog.cancel")}
          </Button>
          <Button
            type="button"
            onClick={confirmAccessDialog}
            disabled={
              accessSaving ||
              (accessModeDraft === "cloud-email" &&
                accessEmailsDraft.length === 0 &&
                !accessEmailInput.trim())
            }
          >
            {accessSaving ? t("installed.accessDialog.saving") : t("installed.accessDialog.save")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );

  return {
    lifecycleBusy,
    accessBusy,
    bulkUpgradePending: bulkUpgradeMutation.isPending,
    isAppActing,
    actingLabelFor,
    freshCandidate,
    upgradeTargets,
    toggle: (app) => void toggleApp(app),
    upgrade,
    upgradeAll,
    requestUninstall,
    requestPublish,
    requestAccess,
    startChatToUpdate,
    dialogs,
  };
}
