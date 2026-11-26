import type {
  AppConnectionAccessAuditPage,
  AppConnectionAccessOperationDto,
  AppConnectionAccessPolicyDto,
  AppConnectionScopeCheck,
  ConnectionAppAccessDto,
  PutAppConnectionAccessPolicy,
} from "@rome/api-types/app-connection-access";
import { Section, SectionHeader, SectionHeading } from "@rome-os/ui/page";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAppsList } from "@/hooks/use-apps";
import { fetchJson, FetchJsonError } from "@/lib/fetch-json";

type Identity = ConnectionAppAccessDto["identities"][number];
type Expiry = "keep" | "never" | "7d" | "30d";

function AccessSelect({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <label className="text-ui" htmlFor={id}>
        {label}
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} className="w-full max-w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

export function ConnectionAppAccess({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const headingId = useId();
  const [tab, setTab] = useState("access");
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
  )
    return null;

  return (
    <Section aria-labelledby={headingId}>
      <SectionHeader>
        <SectionHeading>
          <h3 id={headingId} data-slot="section-title" className="text-section text-foreground">
            {t("title")}
          </h3>
        </SectionHeading>
      </SectionHeader>
      {detail.isError ? (
        <div className="flex flex-wrap items-center gap-2">
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
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-labelledby={headingId}>
            <TabsTrigger value="access">{t("access")}</TabsTrigger>
            <TabsTrigger value="audit">{t("audit")}</TabsTrigger>
          </TabsList>
          <TabsContent value="access" forceMount hidden={tab !== "access"}>
            <Permissions
              endpoint={endpoint}
              detail={detail.data}
              apps={apps}
              refresh={() => {
                apps.retry();
                void detail.refetch();
              }}
            />
          </TabsContent>
          <TabsContent value="audit">
            <AuditLog endpoint={endpoint} detail={detail.data} apps={apps.apps ?? []} />
          </TabsContent>
        </Tabs>
      )}
    </Section>
  );
}

function Permissions({
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
  const [selectedApp, setSelectedApp] = useState("");
  const [selectedIdentity, setSelectedIdentity] = useState("");
  const app =
    apps.apps?.find(({ id }) => id === selectedApp) ??
    apps.apps?.find(({ isEnabled }) => isEnabled) ??
    apps.apps?.[0];
  const identity =
    detail.identities.find((item) => item.identity === selectedIdentity) ??
    detail.identities.find((item) => item.operations.length > 0);
  const policies = detail.policies.filter((policy) => policy.appId === app?.id);
  const byOperation = new Map(
    policies
      .filter((policy) => policy.identity === identity?.identity)
      .map((policy) => [policy.operation, policy]),
  );
  const readOperations =
    identity?.operations.filter(
      (operation) => operation.sideEffect === "read-only" && !byOperation.has(operation.name),
    ) ?? [];

  const change = useMutation({
    mutationFn: async (
      requests: Array<
        { put: PutAppConnectionAccessPolicy } | { revoke: AppConnectionAccessPolicyDto }
      >,
    ) => {
      const results = await Promise.allSettled(
        requests.map((item) => {
          if ("put" in item) {
            return fetchJson<{ policy: AppConnectionAccessPolicyDto }>(`${endpoint}/policies`, {
              method: "PUT",
              json: item.put,
              fallback: t("saveFailed"),
            });
          }
          const { appId, identity, operation } = item.revoke;
          const path = [appId, identity, operation].map(encodeURIComponent).join("/");
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
  const groupNames = new Map(
    Object.entries({
      document: t("groups.document"),
      drive: t("groups.drive"),
      wiki: t("groups.wiki"),
      base: t("groups.base"),
      sheets: t("groups.sheets"),
      calendar: t("groups.calendar"),
      im: t("groups.im"),
      scopes: t("groups.scopes"),
    }),
  );
  const groups = new Map<string, AppConnectionAccessOperationDto[]>();
  for (const operation of identity?.operations ?? []) {
    const segments = operation.name.split(".");
    const group = segments[0] === detail.connection.connectionKind ? segments[1] : segments[0];
    const label =
      !group || segments.length < 2 ? t("groups.other") : (groupNames.get(group) ?? group);
    const operations = groups.get(label) ?? [];
    operations.push(operation);
    groups.set(label, operations);
  }

  const busy = change.isPending;
  const canGrant = app?.isEnabled && identity?.actState === "available";

  return (
    <div className="space-y-4">
      {apps.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui text-muted-foreground">
            {apps.error.message}
          </p>
          <Button size="sm" variant="outline" onClick={apps.retry}>
            {t("retry")}
          </Button>
        </div>
      )}
      {!app && !apps.error && (
        <p className="text-ui text-muted-foreground">
          {t(apps.loading ? "loadingApps" : "emptyApps")}
        </p>
      )}
      {identity && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            {app && (
              <AccessSelect
                label={t("app")}
                value={app.id}
                onChange={setSelectedApp}
                disabled={busy}
              >
                {apps.apps?.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {t("appOption", { name: item.displayName, id: item.id })}
                    {detail.policies.some((policy) => policy.appId === item.id) &&
                      ` · ${t("hasGrants")}`}
                    {!item.isEnabled && ` · ${t("disabled")}`}
                  </SelectItem>
                ))}
              </AccessSelect>
            )}
            {detail.identities.length > 1 && (
              <AccessSelect
                label={t("identity")}
                value={identity.identity}
                onChange={setSelectedIdentity}
                disabled={busy}
              >
                {detail.identities.map((item) => (
                  <SelectItem key={item.identity} value={item.identity}>
                    {item.identity}
                  </SelectItem>
                ))}
              </AccessSelect>
            )}
          </div>
          <ProviderScopes
            key={`${identity.identity}:${identity.actState}`}
            endpoint={endpoint}
            identity={identity}
            policies={byOperation}
          />
          {identity.actState !== "available" && (
            <p className="text-ui text-muted-foreground">
              {t(`identityState.${identity.actState}`)}
            </p>
          )}
          {app && (
            <>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !canGrant || readOperations.length === 0}
                  onClick={() =>
                    change.mutate(
                      readOperations.map((operation) => ({
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || policies.length === 0}
                  onClick={() => change.mutate(policies.map((policy) => ({ revoke: policy })))}
                >
                  {t("revokeAll")}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={refresh}>
                  {t("refresh")}
                </Button>
              </div>
              {change.isError && (
                <p className="text-ui text-destructive-fg" role="alert">
                  {change.error instanceof FetchJsonError &&
                  change.error.status === 409 &&
                  change.error.code === "policy_conflict"
                    ? t("policyConflict")
                    : change.error.message || t("saveFailed")}
                </p>
              )}
              {groups.size === 0 && (
                <p className="text-ui text-muted-foreground">{t("emptyOperations")}</p>
              )}
              {[...groups].map(([group, operations]) => (
                <div key={group} className="space-y-2">
                  <h4 className="text-ui font-medium">{group}</h4>
                  <ul className="space-y-2">
                    {operations.map((operation) => {
                      const policy = byOperation.get(operation.name);
                      return (
                        <OperationRow
                          key={JSON.stringify([
                            app.id,
                            identity.identity,
                            operation.name,
                            policy?.revision,
                          ])}
                          operation={operation}
                          policy={policy}
                          canGrant={!!canGrant && !busy}
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
                  </ul>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function documentIds(input: string): string[] | null {
  const ids = new Set<string>();
  for (const part of input.split(/[,\n]/)) {
    let id = part.trim();
    if (!id) continue;
    if (/^https:\/\//i.test(id)) {
      let url: URL;
      try {
        url = new URL(id);
      } catch {
        return null;
      }
      if (
        url.username ||
        url.password ||
        !/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(url.hostname)
      )
        return null;
      id = /^\/docx\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? "";
    }
    if (!/^[a-zA-Z0-9]{1,128}$/.test(id)) return null;
    ids.add(id);
  }
  return ids.size <= 100 ? [...ids] : null;
}

function OperationRow({
  operation,
  policy,
  canGrant,
  busy,
  onSave,
  onRevoke,
}: {
  operation: AppConnectionAccessOperationDto;
  policy?: AppConnectionAccessPolicyDto;
  canGrant: boolean;
  busy: boolean;
  onSave: (
    values: Pick<PutAppConnectionAccessPolicy, "constraints" | "expiresAt" | "approvalMode">,
  ) => void;
  onRevoke: () => void;
}) {
  const { t, i18n } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const allowlistId = useId();
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
  const ids = operation.resourceConstraintKind === "documentIds" ? documentIds(allowlist) : [];
  const edited = operation.resourceConstraintKind === "documentIds" && ids?.join("\n") !== original;
  const requirements = scopeRequirements(operation, i18n.language);
  const save = () => {
    if (!ids) return;
    const expiresAt =
      expiry === "keep"
        ? policy?.expiresAt
        : expiry === "never"
          ? null
          : new Date(Date.now() + (expiry === "7d" ? 7 : 30) * 86_400_000).toISOString();
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
    <li className="space-y-2 rounded-12 border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="break-all font-medium text-ui">{operation.name}</span>
        <Badge variant="muted">{t(`sideEffect.${operation.sideEffect}`)}</Badge>
        {(operation.approvalRequired || policy?.approvalMode === "required") && (
          <Badge variant="outline">{t("approvalRequired")}</Badge>
        )}
        {policy && <Badge variant="outline">{t(`grantStatus.${policy.grantStatus}`)}</Badge>}
      </div>
      {operation.summary && <p className="text-ui text-muted-foreground">{operation.summary}</p>}
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
          <label className="text-ui" htmlFor={allowlistId}>
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
      <div className="flex flex-wrap items-end gap-2">
        <AccessSelect
          label={t("expiry")}
          value={expiry}
          onChange={(value) => setExpiry(value as Expiry)}
          disabled={!canGrant}
        >
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
        </AccessSelect>
        <Button size="sm" variant="outline" onClick={save} disabled={!canGrant || !ids}>
          {t(policy ? "save" : "grant")}
        </Button>
        {policy && (
          <Button size="sm" variant="ghost" onClick={onRevoke} disabled={busy}>
            {t("revoke")}
          </Button>
        )}
      </div>
    </li>
  );
}

function scopeRequirements(operation: AppConnectionAccessOperationDto, language: string) {
  const alternatives = operation.requiredScopeGroups ?? [];
  const grouped = new Set(alternatives.flat());
  const standalone = operation.requiredScopes?.filter((scope) => !grouped.has(scope)) ?? [];
  const groups = [...alternatives, ...standalone.map((scope) => [scope])];
  const format = new Intl.ListFormat(language, { type: "disjunction" });
  return groups.map((scopes) => ({ scopes, label: format.format(scopes) }));
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
  const check = useMutation({
    mutationFn: () =>
      fetchJson<AppConnectionScopeCheck>(`${endpoint}/scopes/check`, {
        method: "POST",
        fallback: t("scopeStatus.error"),
      }),
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
  const links = [
    [guidance.consoleUrl, t("providerConsole")],
    [guidance.scopesUrl, t("providerPermissions")],
    [guidance.docsUrl, t("providerDocs")],
  ] as const;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        {links.map(
          ([url, label]) =>
            url &&
            /^https?:\/\//i.test(url) && (
              <a
                key={label}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="text-ui text-primary underline underline-offset-2"
              >
                {label}
              </a>
            ),
        )}
        {guidance.scopeCheckOperation && (
          <Button
            size="sm"
            variant="outline"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {t(check.isPending ? "checkingScopes" : "checkScopes")}
          </Button>
        )}
      </div>
      {status && (
        <div className="space-y-1" role="status">
          <p className="text-ui">{t(`scopeStatus.${status}`)}</p>
          {result?.errorCode && (
            <p className="text-aux text-muted-foreground">{result.errorCode}</p>
          )}
          {result && (
            <p className="text-aux text-muted-foreground">
              {t("checkedAt", {
                date: new Date(result.checkedAt).toLocaleString(i18n.language),
              })}
            </p>
          )}
          {status === "checked" &&
            result?.scopes &&
            (required.size > 0 ? (
              <ul className="space-y-1">
                {[...required]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([label, scopes]) => (
                    <li key={label} className="flex flex-wrap items-center gap-2 text-ui">
                      <span className="break-all">{label}</span>
                      <Badge variant="outline">
                        {t(
                          scopes.some((scope) => granted.has(scope))
                            ? "scopeGranted"
                            : "scopeMissing",
                        )}
                      </Badge>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-aux text-muted-foreground">{t("noRequiredScopes")}</p>
            ))}
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
  const [appId, setAppId] = useState("");
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
      <div className="flex">
        <AccessSelect
          label={t("auditApp")}
          value={appId ? `app:${appId}` : "all"}
          onChange={(value) => setAppId(value === "all" ? "" : value.slice(4))}
        >
          <SelectItem value="all">{t("allApps")}</SelectItem>
          {[...appIds].map((id) => (
            <SelectItem key={id} value={`app:${id}`}>
              {appNames.get(id) ?? id}
            </SelectItem>
          ))}
        </AccessSelect>
      </div>
      {audit.isPending && <p className="text-ui text-muted-foreground">{t("loadingAudit")}</p>}
      {audit.isError && (
        <div className="flex flex-wrap items-center gap-2">
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
        <p className="text-ui text-muted-foreground">{t("emptyAudit")}</p>
      )}
      <ul className="space-y-2">
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
          return (
            <li
              key={entry.seq}
              className="space-y-1 rounded-12 border border-border bg-surface p-3"
            >
              <time dateTime={entry.createdAt} className="text-aux text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString(i18n.language)}
              </time>
              <p className="break-all text-ui">
                {entry.appId} · {entry.operation}
              </p>
              <div className="flex flex-wrap gap-2">
                <Badge variant="muted">{t(`sideEffect.${sideEffect ?? "unknown"}`)}</Badge>
                <Badge variant={outcome === "outcome_unknown" ? "warning" : "outline"}>
                  {t(`outcome.${outcome}`)}
                </Badge>
                <Badge variant="outline">{t(`approval.${entry.approval}`)}</Badge>
              </div>
              {outcome === "failed" && (
                <p className="break-all text-aux text-muted-foreground">
                  {t("auditError", { code: entry.status })}
                </p>
              )}
              <p className="break-all text-aux text-muted-foreground">
                {t("execution", { id: entry.executionId })}
                {entry.requestIdHash && ` · ${t("request", { hash: entry.requestIdHash })}`}
                {entry.accessRevision !== null &&
                  ` · ${t("revision", { revision: entry.accessRevision })}`}
              </p>
            </li>
          );
        })}
      </ul>
      {audit.hasNextPage && (
        <Button
          size="sm"
          variant="outline"
          disabled={audit.isFetching}
          onClick={() => void audit.fetchNextPage()}
        >
          {t(audit.isFetchingNextPage ? "loadingAudit" : "loadMore")}
        </Button>
      )}
    </div>
  );
}
