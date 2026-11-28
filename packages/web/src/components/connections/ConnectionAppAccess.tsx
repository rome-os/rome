import type {
  AppConnectionAccessAuditPage,
  AppConnectionAccessOperationDto,
  AppConnectionAccessPolicyDto,
  AppConnectionScopeCheck,
  ConnectionAppAccessDto,
  PutAppConnectionAccessPolicy,
} from "@rome/api-types/app-connection-access";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@rome-os/ui/list-row";
import { Section, SectionActions, SectionHeader, SectionHeading } from "@rome-os/ui/page";
import { SegmentedControl } from "@rome-os/ui/segmented-control";
import {
  QueryClientContext,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useContext, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppsList } from "@/hooks/use-apps";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import {
  extraPermissionIds,
  GROUP_ORDER,
  type OperationGroupKey,
  operationDocUrl,
  operationGroupKey,
  operationI18nKey,
  primaryPermissionIds,
  scopeRequirements,
} from "./connection-operation-labels";

type Identity = ConnectionAppAccessDto["identities"][number];
type OperationAccessMode = "disabled" | "allow" | "ask";
type AccessTemplateId = "readOnly" | "readAndWrite" | "docsAndWiki";
type TabValue = "access" | "audit";
type QuickGrantPreset = "read" | "read_and_write";

interface ResolvedAppSummary {
  id: string;
  displayName: string;
  isEnabled: boolean;
  iconUrl?: string | null;
}

type PolicyChangeRequest =
  | { put: PutAppConnectionAccessPolicy }
  | { revoke: AppConnectionAccessPolicyDto };

function AppMonogram({ app }: { app: ResolvedAppSummary }) {
  const initial = (app.displayName || app.id).trim().slice(0, 1).toUpperCase() || "?";
  if (app.iconUrl) {
    return (
      <img
        src={app.iconUrl}
        alt=""
        className="size-8 shrink-0 rounded-8 border border-border-subtle object-cover"
      />
    );
  }
  return (
    <div
      aria-hidden
      className="flex size-8 shrink-0 items-center justify-center rounded-8 border border-border-subtle bg-background text-ui font-medium text-foreground"
    >
      {initial}
    </div>
  );
}

function useOperationCopy() {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  return {
    titleOf: (operationName: string) => {
      const key = operationI18nKey(operationName);
      return key ? t(`operations.${key}.title`, { defaultValue: operationName }) : operationName;
    },
    descriptionOf: (operation: Pick<AppConnectionAccessOperationDto, "name" | "summary">) => {
      const key = operationI18nKey(operation.name);
      return key
        ? t(`operations.${key}.description`, { defaultValue: operation.summary ?? "" })
        : (operation.summary ?? "");
    },
  };
}

function summarizePolicies(
  policies: readonly AppConnectionAccessPolicyDto[],
  t: ReturnType<typeof useTranslation<"settings", "connectionAppAccess">>["t"],
): string {
  const readCount = policies.filter((item) => item.sideEffect === "read-only").length;
  const writeCount = policies.filter((item) => item.sideEffect === "write").length;
  const parts: string[] = [];
  if (readCount > 0) parts.push(t("readCount", { count: readCount }));
  if (writeCount > 0) parts.push(t("writeCount", { count: writeCount }));
  return parts.length > 0 ? parts.join(" · ") : t("noActiveGrants");
}

export function ConnectionAppAccess({ connectionId }: { connectionId: string }) {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) return null;
  return <ConnectionAppAccessPanel connectionId={connectionId} />;
}

function ConnectionAppAccessPanel({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const headingId = useId();
  const [tab, setTab] = useState<TabValue>("access");
  const endpoint = `/api/app-connection-access/connections/${encodeURIComponent(connectionId)}`;
  const detail = useQuery({
    queryKey: [endpoint],
    queryFn: ({ signal }) =>
      fetchJson<ConnectionAppAccessDto>(endpoint, {
        signal,
        fallback: t("loadFailed"),
      }),
  });
  const visible = detail.data?.identities?.some((identity) => identity.operations.length > 0);
  const apps = useAppsList({ enabled: visible === true });

  if (
    detail.isPending ||
    (detail.isSuccess && !visible) ||
    (detail.error instanceof FetchJsonError && detail.error.status === 404)
  ) {
    return null;
  }

  const refresh = () => {
    apps.retry();
    void detail.refetch();
  };

  return (
    <Section aria-labelledby={headingId}>
      <SectionHeader className="items-center gap-2">
        <SectionHeading>
          <h3
            id={headingId}
            data-slot="section-title"
            className="text-section [text-wrap-style:balance] text-foreground"
          >
            {t("title")}
          </h3>
        </SectionHeading>
        {detail.isSuccess && (
          <SectionActions>
            {tab === "access" && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("refresh")}
                disabled={detail.isFetching}
                onClick={refresh}
              >
                <RefreshCw className="size-3.5 text-muted-foreground" aria-hidden />
              </Button>
            )}
            <SegmentedControl<TabValue>
              size="sm"
              aria-label={t("title")}
              value={tab}
              onValueChange={setTab}
              options={[
                { value: "access", label: t("access") },
                { value: "audit", label: t("audit") },
              ]}
            />
          </SectionActions>
        )}
      </SectionHeader>

      {detail.isError ? (
        <div className="flex flex-wrap items-center gap-2 rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-3">
          <p role="alert" className="text-ui text-destructive-fg">
            {t("loadFailed")}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={detail.isFetching}
            onClick={() => void detail.refetch()}
          >
            {t("retry")}
          </Button>
        </div>
      ) : tab === "access" ? (
        <AccessManager endpoint={endpoint} detail={detail.data} apps={apps} />
      ) : (
        <AuditLog endpoint={endpoint} detail={detail.data} apps={apps.apps ?? []} />
      )}
    </Section>
  );
}

function AccessManager({
  endpoint,
  detail,
  apps,
}: {
  endpoint: string;
  detail: ConnectionAppAccessDto;
  apps: ReturnType<typeof useAppsList>;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const client = useQueryClient();
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [selectedIdentity, setSelectedIdentity] = useState("");
  const [showAddPanel, setShowAddPanel] = useState(false);

  const installedApps = useMemo<ResolvedAppSummary[]>(
    () =>
      (apps.apps ?? []).map((item) => ({
        id: item.id,
        displayName: item.displayName,
        isEnabled: item.isEnabled,
        iconUrl: item.iconUrl,
      })),
    [apps.apps],
  );

  const appLookup = useMemo(
    () => new Map(installedApps.map((item) => [item.id, item])),
    [installedApps],
  );

  const identity =
    detail.identities.find((item) => item.identity === selectedIdentity) ??
    detail.identities.find((item) => item.operations.length > 0);

  const authorizedApps = useMemo(() => {
    const byApp = new Map<string, AppConnectionAccessPolicyDto[]>();
    for (const policy of detail.policies) {
      const list = byApp.get(policy.appId) ?? [];
      list.push(policy);
      byApp.set(policy.appId, list);
    }
    return [...byApp.entries()]
      .map(([appId, policies]) => ({
        app: appLookup.get(appId) ?? {
          id: appId,
          displayName: appId,
          isEnabled: true,
        },
        policies,
      }))
      .sort((a, b) => a.app.displayName.localeCompare(b.app.displayName));
  }, [appLookup, detail.policies]);

  const authorizedIds = useMemo(
    () => new Set(authorizedApps.map((entry) => entry.app.id)),
    [authorizedApps],
  );

  const unauthorizedApps = useMemo(
    () => installedApps.filter((item) => !authorizedIds.has(item.id)),
    [authorizedIds, installedApps],
  );

  const change = useMutation({
    mutationFn: async (requests: PolicyChangeRequest[]) => {
      const results = await Promise.allSettled(
        requests.map((item) => {
          if ("put" in item) {
            return fetchJson<{ policy: AppConnectionAccessPolicyDto }>(`${endpoint}/policies`, {
              method: "PUT",
              json: item.put,
              fallback: t("saveFailed"),
            });
          }
          const { appId, identity: targetIdentity, operation } = item.revoke;
          const path = [appId, targetIdentity, operation].map(encodeURIComponent).join("/");
          return fetchJson<void>(`${endpoint}/policies/${path}`, {
            method: "DELETE",
            fallback: t("saveFailed"),
          });
        }),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
    onSettled: () => client.invalidateQueries({ queryKey: [endpoint] }),
  });

  const activeApp = activeAppId
    ? (appLookup.get(activeAppId) ?? {
        id: activeAppId,
        displayName: activeAppId,
        isEnabled: false,
      })
    : null;

  const overviewPoliciesForScopes = useMemo(() => {
    const map = new Map<string, AppConnectionAccessPolicyDto>();
    if (!identity) return map;
    for (const policy of detail.policies) {
      if (policy.identity !== identity.identity) continue;
      if (policy.grantStatus === "current") {
        map.set(policy.operation, policy);
      }
    }
    return map;
  }, [detail.policies, identity]);

  if (!identity) return null;

  return (
    <div className="space-y-3">
      {apps.error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-3">
          <p role="alert" className="text-ui text-muted-foreground">
            {apps.error.message}
          </p>
          <Button size="sm" variant="outline" onClick={apps.retry}>
            {t("retry")}
          </Button>
        </div>
      )}

      {identity.actState !== "available" && (
        <p className="rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-3 text-aux text-muted-foreground">
          {t(`identityState.${identity.actState}`)}
        </p>
      )}

      {change.isError && !showAddPanel && !activeApp && (
        <p className="text-ui text-destructive-fg" role="alert">
          {change.error instanceof FetchJsonError &&
          change.error.status === 409 &&
          change.error.code === "policy_conflict"
            ? t("policyConflict")
            : change.error.message || t("saveFailed")}
        </p>
      )}

      {authorizedApps.length > 0 ? (
        <List className="overflow-hidden rounded-12 border border-border-subtle bg-surface">
          {authorizedApps.map(({ app, policies }) => {
            const hasAttention =
              !app.isEnabled || policies.some((policy) => policy.grantStatus !== "current");
            return (
              <ListRow key={app.id} asChild interactive>
                <button
                  type="button"
                  onClick={() => {
                    change.reset();
                    setShowAddPanel(false);
                    setActiveAppId(app.id);
                  }}
                >
                  <AppMonogram app={app} />
                  <ListRowContent>
                    <ListRowTitle className="flex flex-wrap items-center gap-2">
                      <span className="truncate">{app.displayName}</span>
                      {!app.isEnabled && (
                        <Badge variant="muted" className="font-normal">
                          {t("disabled")}
                        </Badge>
                      )}
                      {hasAttention && app.isEnabled && (
                        <Badge variant="warning" className="font-normal">
                          {t("needsAttention")}
                        </Badge>
                      )}
                    </ListRowTitle>
                    <ListRowDescription>{summarizePolicies(policies, t)}</ListRowDescription>
                  </ListRowContent>
                  <ChevronRight className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
                </button>
              </ListRow>
            );
          })}

          {unauthorizedApps.length > 0 && (
            <ListRow asChild interactive>
              <button
                type="button"
                onClick={() => {
                  change.reset();
                  setShowAddPanel(true);
                }}
              >
                <span
                  aria-hidden
                  className="flex h-5 w-8 shrink-0 items-center justify-center text-muted-foreground"
                >
                  <Plus className="size-4" />
                </span>
                <ListRowContent>{t("addApp")}</ListRowContent>
              </button>
            </ListRow>
          )}
        </List>
      ) : (
        <div className="rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-4">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-8 bg-muted text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-ui text-foreground">{t("emptyAuthorizedTitle")}</p>
              <p className="text-aux text-muted-foreground">
                {apps.loading
                  ? t("loadingApps")
                  : installedApps.length === 0 && !apps.error
                    ? t("emptyApps")
                    : t("emptyAuthorizedDescription")}
              </p>
              {installedApps.length > 0 && (
                <div className="pt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      change.reset();
                      setShowAddPanel(true);
                    }}
                  >
                    <Plus className="mr-1 size-3.5" aria-hidden />
                    {t("authorizeManually")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showAddPanel && unauthorizedApps.length > 0 && (
        <ManualAuthorizeDialog
          open
          apps={unauthorizedApps}
          identities={detail.identities}
          selectedIdentity={identity.identity}
          onSelectIdentity={setSelectedIdentity}
          busy={change.isPending}
          errorMessage={
            change.isError
              ? change.error instanceof FetchJsonError &&
                change.error.status === 409 &&
                change.error.code === "policy_conflict"
                ? t("policyConflict")
                : change.error.message || t("saveFailed")
              : null
          }
          onCancel={() => {
            change.reset();
            setShowAddPanel(false);
          }}
          onOpenCustom={(appId) => {
            change.reset();
            setShowAddPanel(false);
            setActiveAppId(appId);
          }}
          onGrantPreset={(appId, targetIdentity, preset) => {
            const ops = targetIdentity.operations.filter((op) =>
              preset === "read" ? op.sideEffect === "read-only" : true,
            );
            change.mutate(
              ops.map((op) => ({
                put: {
                  appId,
                  identity: targetIdentity.identity,
                  operation: op.name,
                  approvalMode: op.sideEffect === "write" ? "required" : "not_required",
                  expectedRevision: 0,
                },
              })),
              {
                onSuccess: () => {
                  setShowAddPanel(false);
                  setActiveAppId(appId);
                },
              },
            );
          }}
        />
      )}

      {activeApp && (
        <AppDetailDialog
          open
          detail={detail}
          app={activeApp}
          identity={identity}
          onSelectIdentity={setSelectedIdentity}
          onClose={() => {
            change.reset();
            setActiveAppId(null);
          }}
          change={change}
        />
      )}

      <ProviderScopes
        key={`${identity.identity}:${identity.actState}:overview`}
        endpoint={endpoint}
        connectionKind={detail.connection.connectionKind}
        identity={identity}
        policies={overviewPoliciesForScopes}
      />
    </div>
  );
}

function ManualAuthorizeDialog({
  open,
  apps,
  identities,
  selectedIdentity,
  onSelectIdentity,
  busy,
  errorMessage,
  onCancel,
  onOpenCustom,
  onGrantPreset,
}: {
  open: boolean;
  apps: readonly ResolvedAppSummary[];
  identities: readonly Identity[];
  selectedIdentity: string;
  onSelectIdentity: (identity: string) => void;
  busy: boolean;
  errorMessage: string | null;
  onCancel: () => void;
  onOpenCustom: (appId: string) => void;
  onGrantPreset: (appId: string, identity: Identity, preset: QuickGrantPreset) => void;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const { t: tSettings } = useTranslation("settings");
  const appSelectId = useId();
  const identitySelectId = useId();
  const defaultApp = apps.find((item) => item.isEnabled)?.id ?? apps[0]?.id ?? "";
  const [selectedAppId, setSelectedAppId] = useState(defaultApp);
  const [preset, setPreset] = useState<QuickGrantPreset>("read");

  const chosenApp = apps.find((item) => item.id === selectedAppId) ?? apps[0];
  const chosenIdentity =
    identities.find((item) => item.identity === selectedIdentity) ?? identities[0];
  const canGrant = Boolean(chosenApp?.isEnabled && chosenIdentity?.actState === "available");

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      modal={busy}
      size="md"
      aria-describedby={undefined}
    >
      <DialogHeader onClose={busy ? undefined : onCancel} closeLabel={tSettings("common.close")}>
        <DialogTitle>{t("manualPanelTitle")}</DialogTitle>
      </DialogHeader>

      <DialogBody className="space-y-4">
        <div className={identities.length > 1 ? "grid gap-3 sm:grid-cols-2" : "space-y-3"}>
          <div className="min-w-0 space-y-1">
            <label htmlFor={appSelectId} className="text-aux text-muted-foreground">
              {t("app")}
            </label>
            <Select value={chosenApp?.id ?? ""} onValueChange={setSelectedAppId} disabled={busy}>
              <SelectTrigger id={appSelectId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {apps.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.displayName}
                    {!item.isEnabled ? ` · ${t("disabled")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {identities.length > 1 && (
            <div className="min-w-0 space-y-1">
              <label htmlFor={identitySelectId} className="text-aux text-muted-foreground">
                {t("identity")}
              </label>
              <Select
                value={chosenIdentity?.identity ?? ""}
                onValueChange={onSelectIdentity}
                disabled={busy}
              >
                <SelectTrigger id={identitySelectId} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {identities.map((item) => (
                    <SelectItem key={item.identity} value={item.identity}>
                      {item.identity}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <span className="block text-aux text-muted-foreground">{t("presetLabel")}</span>
          <SegmentedControl<QuickGrantPreset>
            size="sm"
            aria-label={t("presetLabel")}
            value={preset}
            onValueChange={setPreset}
            disabled={busy}
            options={[
              { value: "read", label: t("presetRead") },
              { value: "read_and_write", label: t("presetReadAndWrite") },
            ]}
          />
          <p className="text-aux text-muted-foreground">
            {preset === "read" ? t("presetReadHint") : t("presetReadAndWriteHint")}
          </p>
        </div>

        {errorMessage && (
          <p className="text-ui text-destructive-fg" role="alert">
            {errorMessage}
          </p>
        )}
      </DialogBody>

      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </Button>
        {chosenApp && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenCustom(chosenApp.id)}
          >
            {t("configureManually")}
          </Button>
        )}
        <Button
          type="button"
          disabled={busy || !canGrant || !chosenApp || !chosenIdentity}
          onClick={() =>
            chosenApp && chosenIdentity && onGrantPreset(chosenApp.id, chosenIdentity, preset)
          }
        >
          {t("grantAndOpen")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function PermissionGroupSection({
  groupKey,
  children,
}: {
  groupKey: OperationGroupKey;
  children: ReactNode;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  return (
    <div className="space-y-2">
      <h4 className="px-[var(--row-px-md)] text-aux text-muted-foreground">
        {t(`groups.${groupKey}`)}
      </h4>
      <List asChild className="overflow-hidden rounded-12 border border-border-subtle bg-surface">
        <ul>{children}</ul>
      </List>
    </div>
  );
}

function PermissionRow({
  title,
  description,
  permissionIds,
  extraPermissionIds: additionalPermissionIds = [],
  permissionSeparator = "·",
  docUrl,
  dataOperation,
  badges,
  trailing,
}: {
  title: string;
  description?: string;
  permissionIds: readonly string[];
  extraPermissionIds?: readonly string[];
  permissionSeparator?: string;
  docUrl?: string | null;
  dataOperation?: string;
  badges?: ReactNode;
  trailing?: ReactNode;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const permissionIdNodes = permissionIds.map((id, index) => (
    <span key={id} className="inline-flex items-center gap-x-1">
      {index > 0 && <span className="font-sans text-subtle-foreground">{permissionSeparator}</span>}
      <code className="break-all">{id}</code>
    </span>
  ));

  return (
    <li data-operation={dataOperation}>
      <ListRow size="md" className="items-center">
        <ListRowContent>
          <ListRowTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground">{title}</span>
            {permissionIds.length > 0 &&
              (docUrl ? (
                <a
                  href={docUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t("viewPermissionDocs", { name: title })}
                  className="inline-flex flex-wrap items-center gap-x-1 font-mono text-aux font-normal text-subtle-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  {permissionIdNodes}
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="inline-flex flex-wrap items-center gap-x-1 font-mono text-aux font-normal text-subtle-foreground">
                  {permissionIdNodes}
                </span>
              ))}
            {additionalPermissionIds.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="muted"
                    tabIndex={0}
                    aria-label={t("additionalPermissions", {
                      count: additionalPermissionIds.length,
                      scopes: additionalPermissionIds.join(", "),
                    })}
                    className="h-4 cursor-default border-0 px-1 font-mono text-xs leading-none font-normal text-muted-foreground"
                  >
                    +{additionalPermissionIds.length}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  <div className="space-y-1 py-1 text-left">
                    <p className="text-aux opacity-80">{t("additionalPermissionsTitle")}</p>
                    <ul className="space-y-1 font-mono text-aux">
                      {additionalPermissionIds.map((scope) => (
                        <li key={scope} className="break-all">
                          {scope}
                        </li>
                      ))}
                    </ul>
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
            {badges}
          </ListRowTitle>
          {description && <ListRowDescription>{description}</ListRowDescription>}
        </ListRowContent>
        {trailing}
      </ListRow>
    </li>
  );
}

function policyAccessMode(policy?: AppConnectionAccessPolicyDto): OperationAccessMode {
  if (!policy) return "disabled";
  return policy.approvalMode === "required" ? "ask" : "allow";
}

function AppDetailDialog({
  open,
  detail,
  app,
  identity,
  onSelectIdentity,
  onClose,
  change,
}: {
  open: boolean;
  detail: ConnectionAppAccessDto;
  app: ResolvedAppSummary;
  identity: Identity;
  onSelectIdentity: (identity: string) => void;
  onClose: () => void;
  change: ReturnType<typeof useMutation<void, Error, PolicyChangeRequest[]>>;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const { t: tSettings } = useTranslation("settings");
  const identitySelectId = useId();

  const appPolicies = detail.policies.filter((policy) => policy.appId === app.id);
  const byOperation = new Map(
    appPolicies
      .filter((policy) => policy.identity === identity.identity)
      .map((policy) => [policy.operation, policy]),
  );

  const groupedOperations = useMemo(() => {
    const map = new Map<OperationGroupKey, AppConnectionAccessOperationDto[]>();
    for (const operation of identity.operations) {
      const key = operationGroupKey(operation.name, detail.connection.connectionKind);
      const list = map.get(key) ?? [];
      list.push(operation);
      map.set(key, list);
    }
    return GROUP_ORDER.filter((key) => map.has(key)).map((key) => ({
      key,
      operations: map.get(key)!,
    }));
  }, [detail.connection.connectionKind, identity.operations]);

  const templates = useMemo(() => {
    const readOps = identity.operations.filter((op) => op.sideEffect === "read-only");
    const writeOps = identity.operations.filter((op) => op.sideEffect === "write");
    const docsWikiGroups = new Set<OperationGroupKey>(["document", "drive", "wiki"]);
    const docsWikiReadOps = readOps.filter((op) =>
      docsWikiGroups.has(operationGroupKey(op.name, detail.connection.connectionKind)),
    );
    const list: Array<{ id: AccessTemplateId }> = [];
    if (readOps.length > 0) list.push({ id: "readOnly" });
    if (writeOps.length > 0) list.push({ id: "readAndWrite" });
    if (docsWikiReadOps.length > 0 && docsWikiReadOps.length < identity.operations.length) {
      list.push({ id: "docsAndWiki" });
    }
    return list;
  }, [detail.connection.connectionKind, identity.operations]);

  const applyTemplate = (templateId: AccessTemplateId) => {
    const docsWikiGroups = new Set<OperationGroupKey>(["document", "drive", "wiki"]);
    const targetOps = identity.operations.filter((op) => {
      if (templateId === "readAndWrite") return true;
      if (templateId === "docsAndWiki") {
        return (
          op.sideEffect === "read-only" &&
          docsWikiGroups.has(operationGroupKey(op.name, detail.connection.connectionKind))
        );
      }
      return op.sideEffect === "read-only";
    });
    const targetNames = new Set(targetOps.map((op) => op.name));
    const requests: PolicyChangeRequest[] = [];

    for (const op of targetOps) {
      const existing = byOperation.get(op.name);
      const desiredApproval = op.sideEffect === "write" ? "required" : "not_required";
      if (existing && existing.approvalMode === desiredApproval) {
        continue;
      }
      requests.push({
        put: {
          appId: app.id,
          identity: identity.identity,
          operation: op.name,
          expectedRevision: existing?.revision ?? 0,
          approvalMode: desiredApproval,
          constraints: existing?.constraints ?? [],
        },
      });
    }

    for (const existing of byOperation.values()) {
      if (!targetNames.has(existing.operation)) {
        requests.push({ revoke: existing });
      }
    }

    if (requests.length > 0) {
      change.mutate(requests);
    }
  };

  const busy = change.isPending;
  const canGrant = app.isEnabled && identity.actState === "available";
  const showToolbar =
    detail.identities.length > 1 || templates.length > 0 || appPolicies.length > 0;

  return (
    <TooltipProvider delayDuration={150}>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) onClose();
        }}
        modal={busy}
        size="lg"
        aria-describedby={undefined}
      >
        <DialogHeader onClose={busy ? undefined : onClose} closeLabel={tSettings("common.close")}>
          <div className="flex min-w-0 items-center gap-3">
            <AppMonogram app={app} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate">{app.displayName}</DialogTitle>
                <span className="truncate font-mono text-aux text-muted-foreground">{app.id}</span>
                {!app.isEnabled && (
                  <Badge variant="muted" className="font-normal">
                    {t("disabled")}
                  </Badge>
                )}
              </div>
              <p className="text-aux text-muted-foreground">{summarizePolicies(appPolicies, t)}</p>
            </div>
          </div>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {showToolbar && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {detail.identities.length > 1 && (
                <div className="flex items-center gap-2">
                  <label htmlFor={identitySelectId} className="text-aux text-muted-foreground">
                    {t("identity")}
                  </label>
                  <Select
                    value={identity.identity}
                    onValueChange={onSelectIdentity}
                    disabled={busy}
                  >
                    <SelectTrigger id={identitySelectId} className="h-8 w-auto min-w-[7rem]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {detail.identities.map((item) => (
                        <SelectItem key={item.identity} value={item.identity}>
                          {item.identity}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="ml-auto flex flex-wrap items-center gap-2">
                {templates.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy || !canGrant}
                        className="gap-2"
                      >
                        <span>{t("useTemplate")}</span>
                        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                      {templates.map(({ id }) => (
                        <DropdownMenuItem
                          key={id}
                          className="flex-col items-start gap-1 py-2"
                          onSelect={() => applyTemplate(id)}
                        >
                          <span className="text-ui text-foreground">
                            {t(`templates.${id}.title`)}
                          </span>
                          <span className="text-aux text-muted-foreground">
                            {t(`templates.${id}.description`)}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {appPolicies.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-destructive-fg hover:text-destructive-fg"
                    disabled={busy}
                    onClick={() => change.mutate(appPolicies.map((policy) => ({ revoke: policy })))}
                  >
                    {t("revokeAll")}
                  </Button>
                )}
              </div>
            </div>
          )}

          {identity.actState !== "available" && (
            <p className="rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-3 text-aux text-muted-foreground">
              {t(`identityState.${identity.actState}`)}
            </p>
          )}

          {change.isError && (
            <p className="text-ui text-destructive-fg" role="alert">
              {change.error instanceof FetchJsonError &&
              change.error.status === 409 &&
              change.error.code === "policy_conflict"
                ? t("policyConflict")
                : change.error.message || t("saveFailed")}
            </p>
          )}

          {groupedOperations.length === 0 ? (
            <p className="text-ui text-muted-foreground">{t("emptyOperations")}</p>
          ) : (
            <div className="space-y-4">
              {groupedOperations.map(({ key, operations }) => (
                <PermissionGroupSection key={key} groupKey={key}>
                  {operations.map((operation) => {
                    const policy = byOperation.get(operation.name);
                    return (
                      <OperationRow
                        key={`${app.id}:${identity.identity}:${operation.name}`}
                        operation={operation}
                        policy={policy}
                        docUrl={operationDocUrl(operation.name, identity.providerGuidance)}
                        canGrant={canGrant && !busy}
                        busy={busy}
                        onSave={(values) =>
                          change.mutate([
                            {
                              put: {
                                appId: app.id,
                                identity: identity.identity,
                                operation: operation.name,
                                expectedRevision: policy?.revision ?? 0,
                                ...values,
                              },
                            },
                          ])
                        }
                        onRevoke={() => policy && change.mutate([{ revoke: policy }])}
                      />
                    );
                  })}
                </PermissionGroupSection>
              ))}
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("done")}
          </Button>
        </DialogFooter>
      </Dialog>
    </TooltipProvider>
  );
}

function OperationRow({
  operation,
  policy,
  docUrl,
  canGrant,
  busy,
  onSave,
  onRevoke,
}: {
  operation: AppConnectionAccessOperationDto;
  policy?: AppConnectionAccessPolicyDto;
  docUrl: string | null;
  canGrant: boolean;
  busy: boolean;
  onSave: (values: Pick<PutAppConnectionAccessPolicy, "constraints" | "approvalMode">) => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const { titleOf, descriptionOf } = useOperationCopy();
  const title = titleOf(operation.name);
  const description = descriptionOf(operation);
  const permissionIds = primaryPermissionIds(operation);
  const extraIds = extraPermissionIds(operation);
  const accessMode = policyAccessMode(policy);
  const constraints = policy?.constraints ?? [];

  const handleModeChange = (nextMode: OperationAccessMode) => {
    if (nextMode === accessMode) return;
    if (nextMode === "disabled") {
      if (policy) onRevoke();
      return;
    }
    onSave({
      approvalMode: nextMode === "ask" ? "required" : "not_required",
      constraints,
    });
  };

  return (
    <PermissionRow
      dataOperation={operation.name}
      title={title}
      description={description || undefined}
      permissionIds={permissionIds}
      extraPermissionIds={extraIds}
      docUrl={docUrl}
      badges={
        policy && policy.grantStatus !== "current" ? (
          <Badge variant="warning" className="font-normal">
            {t(`grantStatus.${policy.grantStatus}`)}
          </Badge>
        ) : undefined
      }
      trailing={
        <Select
          value={accessMode}
          onValueChange={(value) => handleModeChange(value as OperationAccessMode)}
          disabled={busy || (!policy && !canGrant)}
        >
          <SelectTrigger aria-label={title} className="h-8 w-auto min-w-[6.75rem] bg-surface">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="disabled">{t("accessMode.disabled")}</SelectItem>
            <SelectItem value="allow" disabled={!canGrant}>
              {t("accessMode.allow")}
            </SelectItem>
            <SelectItem value="ask" disabled={!canGrant}>
              {t("accessMode.ask")}
            </SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}

interface ScopeCheckRow {
  key: string;
  groupKey: OperationGroupKey;
  operation: AppConnectionAccessOperationDto;
  scopes: string[];
  isGranted: boolean;
}

function ProviderScopes({
  endpoint,
  connectionKind,
  identity,
  policies,
}: {
  endpoint: string;
  connectionKind?: string;
  identity: Identity;
  policies: Map<string, AppConnectionAccessPolicyDto>;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const [dialogOpen, setDialogOpen] = useState(false);
  const check = useMutation({
    mutationFn: () =>
      fetchJson<AppConnectionScopeCheck>(`${endpoint}/scopes/check`, {
        method: "POST",
        fallback: t("scopeStatus.error"),
      }),
  });
  const guidance = identity.providerGuidance;
  if (!guidance) return null;

  const result = check.data;
  const status = check.isError ? "error" : result?.status;
  const granted = new Set(
    result?.scopes
      ?.filter(
        (scope) =>
          scope.grantStatus === 1 &&
          (identity.identity !== "app" || !scope.scopeType || scope.scopeType === "tenant"),
      )
      .map((scope) => scope.scopeName),
  );

  const scopeRows: ScopeCheckRow[] = [];
  if (status === "checked" && result?.scopes) {
    for (const operation of identity.operations) {
      if (policies.get(operation.name)?.grantStatus !== "current") continue;
      const groupKey = operationGroupKey(operation.name, connectionKind);
      for (const { scopes, label } of scopeRequirements(operation, i18n.language)) {
        scopeRows.push({
          key: `${operation.name}:${label}`,
          groupKey,
          operation,
          scopes,
          isGranted: scopes.some((scope) => granted.has(scope)),
        });
      }
    }
  }

  const groupedScopeRows = (() => {
    const map = new Map<OperationGroupKey, ScopeCheckRow[]>();
    for (const row of scopeRows) {
      const list = map.get(row.groupKey) ?? [];
      list.push(row);
      map.set(row.groupKey, list);
    }
    return GROUP_ORDER.filter((key) => map.has(key)).map((key) => ({
      key,
      rows: map.get(key)!.sort((a, b) => Number(a.isGranted) - Number(b.isGranted)),
    }));
  })();

  const missingCount = scopeRows.filter((row) => !row.isGranted).length;
  const primaryLink =
    (guidance.scopesUrl && /^https?:\/\//i.test(guidance.scopesUrl)
      ? { url: guidance.scopesUrl, label: t("providerPermissions") }
      : null) ??
    (guidance.consoleUrl && /^https?:\/\//i.test(guidance.consoleUrl)
      ? { url: guidance.consoleUrl, label: t("providerConsole") }
      : null);

  const footerLinks = [
    primaryLink,
    guidance.consoleUrl &&
    guidance.consoleUrl !== primaryLink?.url &&
    /^https?:\/\//i.test(guidance.consoleUrl)
      ? { url: guidance.consoleUrl, label: t("providerConsole") }
      : null,
    guidance.docsUrl && /^https?:\/\//i.test(guidance.docsUrl)
      ? { url: guidance.docsUrl, label: t("providerDocs") }
      : null,
  ].filter((item): item is { url: string; label: string } => item !== null);

  const StatusIcon =
    status === "checked" && scopeRows.length > 0
      ? missingCount > 0
        ? AlertTriangle
        : CheckCircle2
      : ShieldCheck;

  const statusIconClass =
    status === "checked" && scopeRows.length > 0
      ? missingCount > 0
        ? "text-warning-fg"
        : "text-success-fg"
      : "text-muted-foreground";

  const summaryText =
    status === "checked" && scopeRows.length > 0
      ? missingCount > 0
        ? t("providerScopesMissingSummary", {
            missing: missingCount,
            total: scopeRows.length,
          })
        : t("providerScopesAllGranted", { total: scopeRows.length })
      : t("providerScopesSubtitle");

  const runCheck = () => {
    setDialogOpen(true);
    check.mutate();
  };

  return (
    <>
      <div className="overflow-hidden rounded-12 border border-border-subtle bg-surface">
        <ListRow size="md">
          <div
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-8 bg-muted"
          >
            <StatusIcon className={`size-4 ${statusIconClass}`} />
          </div>
          <ListRowContent>
            <ListRowTitle>{t("providerScopesTitle")}</ListRowTitle>
            <ListRowDescription>{summaryText}</ListRowDescription>
          </ListRowContent>
          <div className="flex shrink-0 items-center gap-2">
            {primaryLink && (
              <a
                href={primaryLink.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 pr-1 text-aux text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>{primaryLink.label}</span>
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {status && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setDialogOpen(true)}>
                {t("viewScopeDetails")}
              </Button>
            )}
            {guidance.scopeCheckOperation && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={check.isPending}
                onClick={runCheck}
              >
                {t(check.isPending ? "checkingScopes" : "checkScopes")}
              </Button>
            )}
          </div>
        </ListRow>
      </div>

      {dialogOpen && (
        <ProviderScopesDialog
          open
          status={status}
          result={result}
          isPending={check.isPending}
          canRecheck={Boolean(guidance.scopeCheckOperation)}
          guidance={guidance}
          summaryText={summaryText}
          StatusIcon={StatusIcon}
          statusIconClass={statusIconClass}
          groupedScopeRows={groupedScopeRows}
          footerLinks={footerLinks}
          onRecheck={() => check.mutate()}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  );
}

function ProviderScopesDialog({
  open,
  status,
  result,
  isPending,
  canRecheck,
  guidance,
  summaryText,
  StatusIcon,
  statusIconClass,
  groupedScopeRows,
  footerLinks,
  onRecheck,
  onClose,
}: {
  open: boolean;
  status: AppConnectionScopeCheck["status"] | undefined;
  result: AppConnectionScopeCheck | undefined;
  isPending: boolean;
  canRecheck: boolean;
  guidance: NonNullable<Identity["providerGuidance"]>;
  summaryText: string;
  StatusIcon: typeof ShieldCheck;
  statusIconClass: string;
  groupedScopeRows: ReadonlyArray<{ key: OperationGroupKey; rows: ScopeCheckRow[] }>;
  footerLinks: ReadonlyArray<{ url: string; label: string }>;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const { t: tSettings } = useTranslation("settings");
  const { titleOf, descriptionOf } = useOperationCopy();

  return (
    <Dialog open={open} onClose={onClose} size="lg" aria-describedby={undefined}>
      <DialogHeader onClose={onClose} closeLabel={tSettings("common.close")}>
        <div className="flex min-w-0 items-center gap-3">
          <div
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-8 bg-muted"
          >
            <StatusIcon className={`size-4 ${statusIconClass}`} />
          </div>
          <div className="min-w-0">
            <DialogTitle>{t("providerScopesTitle")}</DialogTitle>
            <p className="text-aux text-muted-foreground">{summaryText}</p>
          </div>
        </div>
      </DialogHeader>

      <DialogBody className="space-y-4">
        {isPending && !status && (
          <p className="text-ui text-muted-foreground">{t("checkingScopes")}</p>
        )}

        {status && (
          <div role="status" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-2 text-aux">
              <span className="text-foreground">{t(`scopeStatus.${status}`)}</span>
              {result && (
                <span className="text-muted-foreground">
                  {t("checkedAt", {
                    date: new Date(result.checkedAt).toLocaleString(i18n.language),
                  })}
                </span>
              )}
            </div>

            {result?.errorCode && (
              <p className="font-mono text-aux text-muted-foreground">{result.errorCode}</p>
            )}

            {status === "checked" &&
              result?.scopes &&
              (groupedScopeRows.length > 0 ? (
                <div className="space-y-4">
                  {groupedScopeRows.map(({ key, rows }) => (
                    <PermissionGroupSection key={key} groupKey={key}>
                      {rows.map(({ key: rowKey, operation, scopes, isGranted }) => (
                        <PermissionRow
                          key={rowKey}
                          dataOperation={operation.name}
                          title={titleOf(operation.name)}
                          description={descriptionOf(operation) || undefined}
                          permissionIds={scopes}
                          permissionSeparator={t("scopeOr")}
                          docUrl={operationDocUrl(operation.name, guidance)}
                          trailing={
                            <Badge
                              variant={isGranted ? "outline" : "warning"}
                              className="shrink-0 font-normal"
                            >
                              {t(isGranted ? "scopeGranted" : "scopeMissing")}
                            </Badge>
                          }
                        />
                      ))}
                    </PermissionGroupSection>
                  ))}
                </div>
              ) : (
                <p className="text-aux text-muted-foreground">{t("noRequiredScopes")}</p>
              ))}
          </div>
        )}
      </DialogBody>

      <DialogFooter className="flex-wrap justify-between gap-2">
        {footerLinks.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            {footerLinks.map(({ url, label }) => (
              <a
                key={label}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-aux text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>{label}</span>
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canRecheck && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={onRecheck}
            >
              {t(isPending ? "checkingScopes" : "checkScopes")}
            </Button>
          )}
          <Button type="button" size="sm" onClick={onClose}>
            {t("done")}
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

function AuditLog({
  endpoint,
  detail,
  apps,
}: {
  endpoint: string;
  detail: ConnectionAppAccessDto;
  apps: NonNullable<ReturnType<typeof useAppsList>["apps"]>;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const { titleOf } = useOperationCopy();
  const filterId = useId();
  const [appId, setAppId] = useState("");
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null);

  const audit = useInfiniteQuery({
    queryKey: [endpoint, "audit", appId],
    initialPageParam: null as number | null,
    getNextPageParam: (page: AppConnectionAccessAuditPage) => page.nextBeforeSeq ?? undefined,
    queryFn: ({ signal, pageParam }) => {
      const query = new URLSearchParams();
      if (appId) query.set("appId", appId);
      if (pageParam !== null) query.set("beforeSeq", String(pageParam));
      return fetchJson<AppConnectionAccessAuditPage>(
        `${endpoint}/audit${query.size ? `?${query}` : ""}`,
        {
          signal,
          fallback: t("auditFailed"),
        },
      );
    },
  });

  const entries = audit.data?.pages.flatMap((page) => page.entries) ?? [];
  const appNames = new Map(apps.map((app) => [app.id, app.displayName]));
  const appIds = new Set([
    ...appNames.keys(),
    ...entries.map((entry) => entry.appId),
    ...(appId ? [appId] : []),
  ]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label htmlFor={filterId} className="text-aux text-muted-foreground">
          {t("auditApp")}
        </label>
        <Select
          value={appId ? `app:${appId}` : "all"}
          onValueChange={(value) => setAppId(value === "all" ? "" : value.slice(4))}
        >
          <SelectTrigger id={filterId} className="h-8 w-auto min-w-[9rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("allApps")}</SelectItem>
            {[...appIds].map((id) => (
              <SelectItem key={id} value={`app:${id}`}>
                {appNames.get(id) ?? id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {audit.isPending && <p className="text-ui text-muted-foreground">{t("loadingAudit")}</p>}
      {audit.isError && (
        <div className="flex flex-wrap items-center gap-2 rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-3">
          <p role="alert" className="text-ui text-destructive-fg">
            {audit.error.message}
          </p>
          {!audit.isFetchNextPageError && (
            <Button size="sm" variant="outline" onClick={() => void audit.refetch()}>
              {t("retry")}
            </Button>
          )}
        </div>
      )}
      {audit.isSuccess && entries.length === 0 && (
        <p className="rounded-12 border border-border-subtle bg-surface px-[var(--row-px-md)] py-5 text-center text-ui text-muted-foreground">
          {t("emptyAudit")}
        </p>
      )}

      {entries.length > 0 && (
        <List asChild className="overflow-hidden rounded-12 border border-border-subtle bg-surface">
          <ul>
            {entries.map((entry) => {
              const sideEffect = detail.identities
                .find(({ identity }) => identity === entry.identity)
                ?.operations.find(({ name }) => name === entry.operation)?.sideEffect;
              const outcome =
                entry.status === "succeeded" || entry.status === "outcome_unknown"
                  ? entry.status
                  : entry.status === "pending_approval"
                    ? "pending"
                    : "failed";
              const dotClass =
                outcome === "succeeded"
                  ? "bg-success-fg"
                  : outcome === "pending" || outcome === "outcome_unknown"
                    ? "bg-warning-fg"
                    : "bg-destructive-fg";
              const isExpanded = expandedSeq === entry.seq;
              const appLabel = appNames.get(entry.appId) ?? entry.appId;
              const opTitle = titleOf(entry.operation);

              return (
                <li key={entry.seq}>
                  <ListRow asChild interactive size="md">
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() =>
                        setExpandedSeq((current) => (current === entry.seq ? null : entry.seq))
                      }
                    >
                      <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotClass}`} />
                      <ListRowContent>
                        <ListRowTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-foreground">
                            {appLabel} · {opTitle}
                          </span>
                          {outcome === "outcome_unknown" && (
                            <Badge variant="warning" className="font-normal">
                              {t("outcome.outcome_unknown")}
                            </Badge>
                          )}
                          {entry.approval !== "not_required" && (
                            <Badge variant="outline" className="font-normal text-muted-foreground">
                              {t(`approval.${entry.approval}`)}
                            </Badge>
                          )}
                        </ListRowTitle>
                        <ListRowDescription className="flex flex-wrap items-center gap-x-2">
                          <time dateTime={entry.createdAt}>
                            {new Date(entry.createdAt).toLocaleString(i18n.language)}
                          </time>
                          {outcome !== "outcome_unknown" && (
                            <>
                              <span>·</span>
                              <span>{t(`outcome.${outcome}`)}</span>
                            </>
                          )}
                          <span>·</span>
                          <span>{t(`sideEffect.${sideEffect ?? "unknown"}`)}</span>
                        </ListRowDescription>
                      </ListRowContent>
                      {isExpanded ? (
                        <ChevronUp className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
                      ) : (
                        <ChevronDown
                          className="size-4 shrink-0 text-subtle-foreground"
                          aria-hidden
                        />
                      )}
                    </button>
                  </ListRow>

                  {isExpanded && (
                    <div className="space-y-1 border-t border-border-subtle bg-background/60 px-[var(--row-px-md)] py-3 text-aux text-muted-foreground">
                      <p className="break-all font-mono text-foreground/80">{entry.operation}</p>
                      {outcome === "failed" && (
                        <p className="break-all text-destructive-fg">
                          {t("auditError", { code: entry.status })}
                        </p>
                      )}
                      <p className="break-all font-mono">
                        {t("execution", { id: entry.executionId })}
                        {entry.requestIdHash && ` · ${t("request", { hash: entry.requestIdHash })}`}
                        {entry.accessRevision !== null &&
                          ` · ${t("revision", { revision: entry.accessRevision })}`}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </List>
      )}

      {audit.hasNextPage && (
        <div className="flex justify-center">
          <Button
            size="sm"
            variant="outline"
            disabled={audit.isFetching}
            onClick={() => void audit.fetchNextPage()}
          >
            {t(audit.isFetchingNextPage ? "loadingAudit" : "loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
