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
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAppsList } from "@/hooks/use-apps";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";
import {
  expiryPresetToIso,
  GROUP_ORDER,
  type OperationGroupKey,
  operationGroupKey,
  operationI18nKey,
  parseDocumentIds,
  scopeRequirements,
} from "./connection-operation-labels";

type Identity = ConnectionAppAccessDto["identities"][number];
type Expiry = "keep" | "never" | "7d" | "30d";
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

function formatShortDate(iso: string, language: string): string {
  return new Date(iso).toLocaleDateString(language, { month: "short", day: "numeric" });
}

export function ConnectionAppAccess({ connectionId }: { connectionId: string }) {
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

  return (
    <Section aria-labelledby={headingId}>
      <SectionHeader className="flex-wrap gap-2">
        <SectionHeading>
          <h3 id={headingId} data-slot="section-title" className="text-section text-foreground">
            {t("title")}
          </h3>
        </SectionHeading>
        {detail.isSuccess && (
          <SectionActions>
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
        <div className="flex flex-wrap items-center gap-2 rounded-12 border border-border-subtle bg-surface px-4 py-3">
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
        <AccessManager
          endpoint={endpoint}
          detail={detail.data}
          apps={apps}
          refresh={() => {
            apps.retry();
            void detail.refetch();
          }}
        />
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
  refresh,
}: {
  endpoint: string;
  detail: ConnectionAppAccessDto;
  apps: ReturnType<typeof useAppsList>;
  refresh: () => void;
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

  const currentPoliciesForScopes = useMemo(() => {
    const map = new Map<string, AppConnectionAccessPolicyDto>();
    if (!identity) return map;
    for (const policy of detail.policies) {
      if (policy.identity !== identity.identity) continue;
      if (activeApp && policy.appId !== activeApp.id) continue;
      if (policy.grantStatus === "current") {
        map.set(policy.operation, policy);
      }
    }
    return map;
  }, [activeApp, detail.policies, identity]);

  if (!identity) return null;

  if (activeApp) {
    return (
      <AppDetailView
        endpoint={endpoint}
        detail={detail}
        app={activeApp}
        identity={identity}
        onSelectIdentity={setSelectedIdentity}
        onBack={() => {
          change.reset();
          setActiveAppId(null);
        }}
        change={change}
        refresh={refresh}
        policiesForScopes={currentPoliciesForScopes}
      />
    );
  }

  return (
    <div className="space-y-3">
      {apps.error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-12 border border-border-subtle bg-surface px-4 py-3">
          <p role="alert" className="text-ui text-muted-foreground">
            {apps.error.message}
          </p>
          <Button size="sm" variant="outline" onClick={apps.retry}>
            {t("retry")}
          </Button>
        </div>
      )}

      {identity.actState !== "available" && (
        <p className="rounded-12 border border-border-subtle bg-surface px-4 py-2.5 text-aux text-muted-foreground">
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

      {authorizedApps.length > 0 ? (
        <div className="space-y-2">
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
                      <ListRowTitle className="flex flex-wrap items-center gap-2 font-medium">
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
          </List>

          {unauthorizedApps.length > 0 && !showAddPanel && (
            <div className="flex items-center justify-between px-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="-ml-2 gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => setShowAddPanel(true)}
              >
                <Plus className="size-3.5" aria-hidden />
                {t("addApp")}
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={t("refresh")}
                onClick={refresh}
              >
                <RefreshCw className="size-3.5 text-muted-foreground" aria-hidden />
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-12 border border-border-subtle bg-surface px-4 py-5">
          <div className="flex items-start gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-8 bg-muted text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-ui font-medium text-foreground">{t("emptyAuthorizedTitle")}</p>
              <p className="text-aux text-muted-foreground">
                {apps.loading
                  ? t("loadingApps")
                  : installedApps.length === 0 && !apps.error
                    ? t("emptyApps")
                    : t("emptyAuthorizedDescription")}
              </p>
              {installedApps.length > 0 && !showAddPanel && (
                <div className="pt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setShowAddPanel(true)}
                  >
                    <Plus className="mr-1.5 size-3.5" aria-hidden />
                    {t("authorizeManually")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showAddPanel && unauthorizedApps.length > 0 && (
        <ManualAuthorizePanel
          apps={unauthorizedApps}
          identities={detail.identities}
          selectedIdentity={identity.identity}
          onSelectIdentity={setSelectedIdentity}
          busy={change.isPending}
          onCancel={() => setShowAddPanel(false)}
          onOpenCustom={(appId) => {
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
                  approvalMode: op.approvalRequired ? "required" : undefined,
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

      <ProviderScopes
        key={`${identity.identity}:${identity.actState}:overview`}
        endpoint={endpoint}
        identity={identity}
        policies={currentPoliciesForScopes}
      />
    </div>
  );
}

function ManualAuthorizePanel({
  apps,
  identities,
  selectedIdentity,
  onSelectIdentity,
  busy,
  onCancel,
  onOpenCustom,
  onGrantPreset,
}: {
  apps: readonly ResolvedAppSummary[];
  identities: readonly Identity[];
  selectedIdentity: string;
  onSelectIdentity: (identity: string) => void;
  busy: boolean;
  onCancel: () => void;
  onOpenCustom: (appId: string) => void;
  onGrantPreset: (appId: string, identity: Identity, preset: QuickGrantPreset) => void;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
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
    <div className="space-y-3 rounded-12 border border-border-subtle bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-ui font-medium text-foreground">{t("manualPanelTitle")}</p>
        {chosenApp && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-aux text-muted-foreground"
            onClick={() => onOpenCustom(chosenApp.id)}
          >
            {t("configureManually")}
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
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

      <div className="space-y-1.5">
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

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !canGrant || !chosenApp || !chosenIdentity}
          onClick={() =>
            chosenApp && chosenIdentity && onGrantPreset(chosenApp.id, chosenIdentity, preset)
          }
        >
          {t("grantAndOpen")}
        </Button>
      </div>
    </div>
  );
}

function AppDetailView({
  endpoint,
  detail,
  app,
  identity,
  onSelectIdentity,
  onBack,
  change,
  refresh,
  policiesForScopes,
}: {
  endpoint: string;
  detail: ConnectionAppAccessDto;
  app: ResolvedAppSummary;
  identity: Identity;
  onSelectIdentity: (identity: string) => void;
  onBack: () => void;
  change: ReturnType<typeof useMutation<void, Error, PolicyChangeRequest[]>>;
  refresh: () => void;
  policiesForScopes: Map<string, AppConnectionAccessPolicyDto>;
}) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const identitySelectId = useId();
  const [expandedOp, setExpandedOp] = useState<string | null>(null);

  const appPolicies = detail.policies.filter((policy) => policy.appId === app.id);
  const byOperation = new Map(
    appPolicies
      .filter((policy) => policy.identity === identity.identity)
      .map((policy) => [policy.operation, policy]),
  );
  const missingReadOperations = identity.operations.filter(
    (operation) => operation.sideEffect === "read-only" && !byOperation.has(operation.name),
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

  const busy = change.isPending;
  const canGrant = app.isEnabled && identity.actState === "available";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="-ml-2 gap-1 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ChevronLeft className="size-4" aria-hidden />
          {t("back")}
        </Button>

        <div className="flex flex-wrap items-center gap-1.5">
          {missingReadOperations.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !canGrant}
              onClick={() =>
                change.mutate(
                  missingReadOperations.map((operation) => ({
                    put: {
                      appId: app.id,
                      identity: identity.identity,
                      operation: operation.name,
                      expectedRevision: 0,
                    },
                  })),
                )
              }
            >
              {t("grantReads")}
            </Button>
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
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={t("refresh")}
            disabled={busy}
            onClick={refresh}
          >
            <RefreshCw className="size-3.5 text-muted-foreground" aria-hidden />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-12 border border-border-subtle bg-surface px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <AppMonogram app={app} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-ui font-medium text-foreground">
                {app.displayName}
              </span>
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

        {detail.identities.length > 1 && (
          <div className="flex items-center gap-2">
            <label htmlFor={identitySelectId} className="text-aux text-muted-foreground">
              {t("identity")}
            </label>
            <Select value={identity.identity} onValueChange={onSelectIdentity} disabled={busy}>
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
      </div>

      {identity.actState !== "available" && (
        <p className="rounded-12 border border-border-subtle bg-surface px-4 py-2.5 text-aux text-muted-foreground">
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

      <ProviderScopes
        key={`${identity.identity}:${identity.actState}:${app.id}`}
        endpoint={endpoint}
        identity={identity}
        policies={policiesForScopes}
      />

      {groupedOperations.length === 0 ? (
        <p className="text-ui text-muted-foreground">{t("emptyOperations")}</p>
      ) : (
        <div className="space-y-4">
          {groupedOperations.map(({ key, operations }) => (
            <div key={key} className="space-y-1.5">
              <h4 className="px-1 text-aux font-medium text-muted-foreground">
                {t(`groups.${key}`)}
              </h4>
              <List
                asChild
                className="overflow-hidden rounded-12 border border-border-subtle bg-surface"
              >
                <ul>
                  {operations.map((operation) => {
                    const policy = byOperation.get(operation.name);
                    const isExpanded = expandedOp === operation.name;
                    return (
                      <OperationRow
                        key={`${app.id}:${identity.identity}:${operation.name}`}
                        operation={operation}
                        policy={policy}
                        canGrant={canGrant && !busy}
                        busy={busy}
                        expanded={isExpanded}
                        onToggleExpand={() =>
                          setExpandedOp((current) =>
                            current === operation.name ? null : operation.name,
                          )
                        }
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
                </ul>
              </List>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OperationRow({
  operation,
  policy,
  canGrant,
  busy,
  expanded,
  onToggleExpand,
  onSave,
  onRevoke,
}: {
  operation: AppConnectionAccessOperationDto;
  policy?: AppConnectionAccessPolicyDto;
  canGrant: boolean;
  busy: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onSave: (
    values: Pick<PutAppConnectionAccessPolicy, "constraints" | "expiresAt" | "approvalMode">,
  ) => void;
  onRevoke: () => void;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const { titleOf, descriptionOf } = useOperationCopy();
  const title = titleOf(operation.name);
  const description = descriptionOf(operation);

  const constraints = policy?.constraints ?? [];
  const documentRules = constraints.filter((rule) => rule.inputPointer === "/documentId");
  const effectiveIds =
    documentRules[0]?.allowedValues.filter(
      (id): id is string =>
        typeof id === "string" &&
        /^[a-zA-Z0-9]{1,128}$/.test(id) &&
        documentRules.every((rule) => rule.allowedValues.includes(id)),
    ) ?? [];
  const hasCustomConfig = Boolean(policy?.expiresAt || documentRules.length > 0);
  const needsApproval = Boolean(operation.approvalRequired || policy?.approvalMode === "required");

  return (
    <li data-operation={operation.name}>
      <ListRow size="md" className="items-center">
        <ListRowContent>
          <ListRowTitle className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium text-foreground">{title}</span>
            {needsApproval && (
              <Badge variant="outline" className="font-normal text-muted-foreground">
                {t("approvalRequiredShort")}
              </Badge>
            )}
            {policy && policy.grantStatus !== "current" && (
              <Badge variant="warning" className="font-normal">
                {t(`grantStatus.${policy.grantStatus}`)}
              </Badge>
            )}
            {policy?.expiresAt && (
              <span className="text-aux text-muted-foreground">
                {t("expiresShort", { date: formatShortDate(policy.expiresAt, i18n.language) })}
              </span>
            )}
            {documentRules.length > 0 && (
              <span className="text-aux text-muted-foreground">
                {effectiveIds.length > 0
                  ? t("restrictedDocsShort", { count: effectiveIds.length })
                  : t("noAllowedDocumentsShort")}
              </span>
            )}
          </ListRowTitle>
          {description && (
            <ListRowDescription className="line-clamp-1">{description}</ListRowDescription>
          )}
        </ListRowContent>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="icon-sm"
            variant={expanded ? "secondary" : "ghost"}
            aria-label={t("configureOperation", { name: title })}
            aria-expanded={expanded}
            onClick={onToggleExpand}
            className={
              hasCustomConfig && !expanded
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }
          >
            <SlidersHorizontal className="size-3.5" aria-hidden />
          </Button>
          <Switch
            size="sm"
            checked={Boolean(policy)}
            disabled={busy || (!policy && !canGrant)}
            aria-label={title}
            onCheckedChange={(checked) => {
              if (checked) {
                onSave({
                  expiresAt: null,
                  approvalMode: operation.approvalRequired ? "required" : undefined,
                  constraints: [],
                });
              } else {
                onRevoke();
              }
            }}
          />
        </div>
      </ListRow>

      {expanded && (
        <OperationConfigTray
          key={policy?.revision ?? 0}
          operation={operation}
          policy={policy}
          canGrant={canGrant}
          busy={busy}
          onSave={onSave}
          onRevoke={onRevoke}
          onClose={onToggleExpand}
        />
      )}
    </li>
  );
}

function OperationConfigTray({
  operation,
  policy,
  canGrant,
  busy,
  onSave,
  onRevoke,
  onClose,
}: {
  operation: AppConnectionAccessOperationDto;
  policy?: AppConnectionAccessPolicyDto;
  canGrant: boolean;
  busy: boolean;
  onSave: (
    values: Pick<PutAppConnectionAccessPolicy, "constraints" | "expiresAt" | "approvalMode">,
  ) => void;
  onRevoke: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const allowlistId = useId();
  const expiryId = useId();
  const [expiry, setExpiry] = useState<Expiry>(policy?.expiresAt ? "keep" : "never");
  const constraints = policy?.constraints ?? [];
  const documentRules = constraints.filter((rule) => rule.inputPointer === "/documentId");
  const effectiveIds =
    documentRules[0]?.allowedValues.filter(
      (id): id is string =>
        typeof id === "string" &&
        /^[a-zA-Z0-9]{1,128}$/.test(id) &&
        documentRules.every((rule) => rule.allowedValues.includes(id)),
    ) ?? [];
  const original = [...new Set(effectiveIds)].join("\n");
  const [allowlist, setAllowlist] = useState(original);
  const ids = operation.resourceConstraintKind === "documentIds" ? parseDocumentIds(allowlist) : [];
  const edited = operation.resourceConstraintKind === "documentIds" && ids?.join("\n") !== original;
  const requirements = scopeRequirements(operation, i18n.language);

  const save = () => {
    if (!ids) return;
    const expiresAt = expiry === "keep" ? policy?.expiresAt : expiryPresetToIso(expiry);
    onSave({
      expiresAt,
      approvalMode: operation.approvalRequired ? "required" : policy?.approvalMode,
      constraints: edited
        ? [
            ...constraints.filter((rule) => rule.inputPointer !== "/documentId"),
            ...(ids.length ? [{ inputPointer: "/documentId", allowedValues: ids }] : []),
          ]
        : constraints,
    });
  };

  return (
    <div className="space-y-3 border-t border-border-subtle bg-background/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-aux text-muted-foreground">
        <code className="font-mono text-foreground/80">{operation.name}</code>
        <span>·</span>
        <span>{t(`sideEffect.${operation.sideEffect}`)}</span>
        {policy && (
          <>
            <span>·</span>
            <span>{t(`grantStatus.${policy.grantStatus}`)}</span>
          </>
        )}
      </div>

      {operation.approvalPreviewSummary && (
        <p className="text-aux text-muted-foreground">{operation.approvalPreviewSummary}</p>
      )}

      {requirements.length > 0 && (
        <p className="break-words text-aux text-muted-foreground">
          {t("requiredScopes", {
            scopes: requirements.map(({ label }) => label).join("; "),
          })}
        </p>
      )}

      {operation.resourceConstraintKind === "documentIds" && (
        <div className="space-y-1">
          <label className="text-aux font-medium text-foreground" htmlFor={allowlistId}>
            {t("documentIds")}
          </label>
          <Textarea
            id={allowlistId}
            value={allowlist}
            rows={2}
            disabled={!canGrant}
            aria-describedby={`${allowlistId}-help`}
            aria-invalid={ids === null}
            onChange={(event) => setAllowlist(event.target.value)}
            className="bg-surface font-mono text-aux"
          />
          <p id={`${allowlistId}-help`} className="text-aux text-muted-foreground">
            {t(
              ids === null
                ? "invalidDocuments"
                : documentRules.length && !original && !edited
                  ? "noAllowedDocuments"
                  : "documentHelp",
            )}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <label className="block text-aux font-medium text-foreground" htmlFor={expiryId}>
            {t("expiry")}
          </label>
          <Select
            value={expiry}
            onValueChange={(value) => setExpiry(value as Expiry)}
            disabled={!canGrant}
          >
            <SelectTrigger id={expiryId} className="h-8 w-auto min-w-[9rem] bg-surface">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {policy?.expiresAt && (
                <SelectItem value="keep">
                  {t("keepExpiry", {
                    date: new Date(policy.expiresAt).toLocaleString(i18n.language),
                  })}
                </SelectItem>
              )}
              <SelectItem value="never">{t("never")}</SelectItem>
              <SelectItem value="7d">{t("sevenDays")}</SelectItem>
              <SelectItem value="30d">{t("thirtyDays")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          {policy && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive-fg hover:text-destructive-fg"
              onClick={onRevoke}
              disabled={busy}
            >
              {t("revoke")}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={!canGrant || !ids}>
            {t(policy ? "save" : "grant")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProviderScopes({
  endpoint,
  identity,
  policies,
}: {
  endpoint: string;
  identity: Identity;
  policies: Map<string, AppConnectionAccessPolicyDto>;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const [expanded, setExpanded] = useState(true);
  const check = useMutation({
    mutationFn: () =>
      fetchJson<AppConnectionScopeCheck>(`${endpoint}/scopes/check`, {
        method: "POST",
        fallback: t("scopeStatus.error"),
      }),
    onSuccess: () => setExpanded(true),
  });
  const guidance = identity.providerGuidance;
  if (!guidance) return null;

  const required = new Map<string, string[]>();
  for (const operation of identity.operations) {
    if (policies.get(operation.name)?.grantStatus !== "current") continue;
    for (const { scopes, label } of scopeRequirements(operation, i18n.language)) {
      required.set(label, scopes);
    }
  }

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

  const scopeRows =
    status === "checked" && result?.scopes
      ? [...required]
          .map(([label, scopes]) => ({
            label,
            scopes,
            isGranted: scopes.some((scope) => granted.has(scope)),
          }))
          .sort((a, b) => {
            if (a.isGranted !== b.isGranted) return a.isGranted ? 1 : -1;
            return a.label.localeCompare(b.label);
          })
      : [];

  const missingCount = scopeRows.filter((row) => !row.isGranted).length;
  const primaryLink =
    (guidance.scopesUrl && /^https?:\/\//i.test(guidance.scopesUrl)
      ? { url: guidance.scopesUrl, label: t("providerPermissions") }
      : null) ??
    (guidance.consoleUrl && /^https?:\/\//i.test(guidance.consoleUrl)
      ? { url: guidance.consoleUrl, label: t("providerConsole") }
      : null);

  const secondaryLinks = [
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

  return (
    <div className="overflow-hidden rounded-12 border border-border-subtle bg-surface">
      <ListRow size="md">
        <StatusIcon className={`size-4 shrink-0 ${statusIconClass}`} aria-hidden />
        <ListRowContent>
          <ListRowTitle className="font-medium">{t("providerScopesTitle")}</ListRowTitle>
          <ListRowDescription>
            {status === "checked" && scopeRows.length > 0
              ? missingCount > 0
                ? t("providerScopesMissingSummary", {
                    missing: missingCount,
                    total: scopeRows.length,
                  })
                : t("providerScopesAllGranted", { total: scopeRows.length })
              : t("providerScopesSubtitle")}
          </ListRowDescription>
        </ListRowContent>
        <div className="flex shrink-0 items-center gap-2">
          {primaryLink && (
            <a
              href={primaryLink.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-aux text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>{primaryLink.label}</span>
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
          {guidance.scopeCheckOperation && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={check.isPending}
              onClick={() => check.mutate()}
            >
              {t(check.isPending ? "checkingScopes" : "checkScopes")}
            </Button>
          )}
          {status && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-expanded={expanded}
              aria-label={t(expanded ? "collapseDetails" : "expandDetails")}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? (
                <ChevronUp className="size-3.5 text-muted-foreground" aria-hidden />
              ) : (
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
              )}
            </Button>
          )}
        </div>
      </ListRow>

      {status && expanded && (
        <div
          role="status"
          className="space-y-2 border-t border-border-subtle bg-background/50 px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-aux">
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
            (scopeRows.length > 0 ? (
              <ul className="divide-y divide-border-subtle overflow-hidden rounded-8 border border-border-subtle bg-surface">
                {scopeRows.map(({ label, scopes, isGranted }) => (
                  <li
                    key={label}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-aux"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span
                        aria-hidden
                        className={`size-1.5 shrink-0 rounded-full ${
                          isGranted ? "bg-success-fg" : "bg-warning-fg"
                        }`}
                      />
                      <span className="flex flex-wrap items-center gap-1 font-mono text-foreground">
                        {scopes.map((scope, index) => (
                          <span key={scope} className="inline-flex items-center gap-1">
                            {index > 0 && (
                              <span className="font-sans text-muted-foreground">
                                {t("scopeOr")}
                              </span>
                            )}
                            <code className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-aux">
                              {scope}
                            </code>
                          </span>
                        ))}
                      </span>
                    </div>
                    <Badge
                      variant={isGranted ? "outline" : "warning"}
                      className="shrink-0 font-normal"
                    >
                      {t(isGranted ? "scopeGranted" : "scopeMissing")}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-aux text-muted-foreground">{t("noRequiredScopes")}</p>
            ))}

          {secondaryLinks.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              {secondaryLinks.map(({ url, label }) => (
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
        </div>
      )}
    </div>
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
        <div className="flex flex-wrap items-center gap-2 rounded-12 border border-border-subtle bg-surface px-4 py-3">
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
        <p className="rounded-12 border border-border-subtle bg-surface px-4 py-5 text-center text-ui text-muted-foreground">
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
                          <span className="font-medium text-foreground">
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
                    <div className="space-y-1 border-t border-border-subtle bg-background/60 px-4 py-2.5 text-aux text-muted-foreground">
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
