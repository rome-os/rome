import { pairingPayload } from "@rome/api-types/approvals";
import { PairingApproval, ApprovalHistoryButton } from "@/components/PairingApproval";
import { useApprovals, useResolveApproval } from "@/hooks/use-approvals";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  getApprovalDisplayStatus,
  hasActivityError,
  matchesActivityFilter,
  type StatusFilter,
} from "@/lib/activity-status";
import { artifactLocalName } from "@/lib/artifact-name";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { PageShell, PageBody } from "@/shell/PageShell";
import type { ApprovalStatus, ApprovalType } from "@rome/api-types/approvals";

export interface Approval {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedBy: string;
  description: string;
  payload: unknown;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  executedAt: string | null;
  executionError: string | null;
}

export interface SessionActor {
  kind: "guardian" | "visitor" | "anonymous";
  userId?: string;
  accountId?: string;
  email?: string;
  via?: "cookie" | "loopback";
}

export interface ActionExecution {
  id: string;
  rootExecutionId: string;
  actionName: string;
  actionType: string | null;
  status: "running" | "success" | "error" | "pending_approval" | "cancelled";
  args: unknown;
  error: string | null;
  durationMs: number | null;
  initiator: string | null;
  actor: SessionActor | null;
  parentId: string | null;
  startedAt: string;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  cancellationReason: string | null;
  createdAt: string;
}

export interface ExecutionGroup {
  rootExecution: ActionExecution;
  children: ActionExecution[];
}

export interface WebhookInvocation {
  executionId: string;
  actionName: string;
  args: unknown;
  callbackUrl: string | null;
  status: "accepted" | "running" | "success" | "error" | "pending_approval" | "cancelled";
  result: unknown;
  error: string | null;
  callbackStatus: "not_requested" | "pending" | "succeeded" | "failed";
  callbackAttemptedAt: string | null;
  callbackDeliveredAt: string | null;
  callbackResponseStatus: number | null;
  callbackError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

type ActivityItem =
  | { kind: "approval"; data: Approval }
  | { kind: "execution_group"; data: ExecutionGroup }
  | { kind: "webhook_invocation"; data: WebhookInvocation };

type StatusStyle = {
  bar: string;
  dot: string;
  pill: string;
  live?: boolean;
};

// Visual styling per status code; labels come from i18n at render time
// via t("status.<code>").
const STATUS_STYLE: Record<string, StatusStyle> = {
  accepted: {
    bar: "border-info",
    dot: "bg-info",
    pill: "bg-info-bg text-info-fg ring-info-border",
  },
  approved: {
    bar: "border-success",
    dot: "bg-success",
    pill: "bg-success-bg text-success-fg ring-success-border",
  },
  rejected: {
    bar: "border-destructive",
    dot: "bg-destructive",
    pill: "bg-destructive-bg text-destructive-fg ring-destructive-border",
  },
  auto_approved: {
    bar: "border-info",
    dot: "bg-info",
    pill: "bg-info-bg text-info-fg ring-info-border",
  },
  pending: {
    bar: "border-warning",
    dot: "bg-warning",
    pill: "bg-warning-bg text-warning-fg ring-warning-border",
    live: true,
  },
  executed: {
    bar: "border-success",
    dot: "bg-success",
    pill: "bg-success-bg text-success-fg ring-success-border",
  },
  execution_failed: {
    bar: "border-destructive",
    dot: "bg-destructive",
    pill: "bg-destructive-bg text-destructive-fg ring-destructive-border",
  },
  awaiting_execution: {
    bar: "border-warning",
    dot: "bg-warning",
    pill: "bg-warning-bg text-warning-fg ring-warning-border",
    live: true,
  },
  running: {
    bar: "border-info",
    dot: "bg-info",
    pill: "bg-info-bg text-info-fg ring-info-border",
    live: true,
  },
  success: {
    bar: "border-success",
    dot: "bg-success",
    pill: "bg-success-bg text-success-fg ring-success-border",
  },
  error: {
    bar: "border-destructive",
    dot: "bg-destructive",
    pill: "bg-destructive-bg text-destructive-fg ring-destructive-border",
  },
  pending_approval: {
    bar: "border-warning",
    dot: "bg-warning",
    pill: "bg-warning-bg text-warning-fg ring-warning-border",
    live: true,
  },
  cancelled: {
    bar: "border-border-strong",
    dot: "bg-border-strong",
    pill: "bg-surface-muted text-foreground ring-border",
  },
};

const FALLBACK_STYLE: StatusStyle = {
  bar: "border-border-strong",
  dot: "bg-border-strong",
  pill: "bg-surface-muted text-foreground ring-border",
};

const TYPE_TINTS: Record<string, string> = {
  person_mapping: "text-brand",
  outgoing_message: "text-info-fg",
  workflow_creation: "text-warning-fg",
  skill_creation: "text-success-fg",
  tool_creation: "text-info-fg",
  action_execution: "text-brand",
  webhook: "text-info-fg",
};

function statusLabel(t: TFunction<"activity">, status: string): string {
  // Fall back to the un-prefixed status code if unknown so a new
  // server-side status is still readable rather than rendering "status.foo".
  const translated = t(`status.${status}`, { defaultValue: "" });
  return translated || status.replace(/_/g, " ");
}

function timeAgo(t: TFunction<"activity">, dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 5) return t("timeAgo.justNow");
  if (diffSec < 60) return t("timeAgo.secondsAgo", { n: diffSec });
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t("timeAgo.minutesAgo", { n: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t("timeAgo.hoursAgo", { n: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  return t("timeAgo.daysAgo", { n: diffDay });
}

function formatDuration(t: TFunction<"activity">, ms: number | null): string {
  if (ms == null) return t("duration.none");
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function actorLabel(t: TFunction<"activity">, actor: SessionActor): string {
  if (actor.kind === "guardian") {
    return actor.email
      ? `${t("execution.actorGuardian")} · ${actor.email}`
      : t("execution.actorGuardian");
  }
  if (actor.kind === "visitor") {
    return actor.email ?? actor.accountId ?? "";
  }
  return t("execution.actorAnonymous");
}

function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation("activity");
  const style = STATUS_STYLE[status] ?? FALLBACK_STYLE;
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-2 py-1 text-badge ring-1 ring-inset ${style.pill}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${style.dot}`}
        style={
          style.live ? { animation: "rome-activity-pulse 1.8s ease-in-out infinite" } : undefined
        }
      />
      {statusLabel(t, status)}
    </span>
  );
}

function TypeTag({ type }: { type: string }) {
  const tint = TYPE_TINTS[type] ?? "text-muted-foreground";
  return <span className={`text-badge ${tint}`}>{type.replace(/_/g, " ")}</span>;
}

function TimeMeta({ children }: { children: React.ReactNode }) {
  return <span className="text-aux tabular-nums text-subtle-foreground">{children}</span>;
}

function Collapsible({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 text-aux text-muted-foreground transition-colors hover:text-foreground"
      >
        <span
          className={`inline-block transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
        {label}
      </button>
      {open && (
        <div className="mt-2" style={{ animation: "rome-activity-rise 0.18s ease-out" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-8 border border-border bg-surface-muted p-3 font-mono text-aux text-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function CardShell({ status, children }: { status: string; children: React.ReactNode }) {
  const m = STATUS_STYLE[status] ?? FALLBACK_STYLE;
  return (
    <article
      className="group relative overflow-hidden rounded-12 border border-border bg-surface shadow-1 transition-all duration-200 hover:border-border-strong hover:shadow-4"
      style={{ animation: "rome-activity-rise 0.25s ease-out backwards" }}
    >
      <div className={`absolute inset-y-0 left-0 border-l-3 ${m.bar}`} aria-hidden="true" />
      <div className="relative p-4 pl-5">{children}</div>
    </article>
  );
}

function ApprovalCard({
  approval,
  onAction,
  onRetry,
}: {
  approval: Approval;
  onAction: (id: string, action: "approve" | "reject") => Promise<void>;
  onRetry: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("activity");
  const isPending = approval.status === "pending";
  const displayStatus = getApprovalDisplayStatus(approval);
  const [acting, setActing] = useState<"approve" | "reject" | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState("");
  const canRetry = approval.type === "action_execution" && displayStatus === "execution_failed";

  async function handleAction(action: "approve" | "reject") {
    setActing(action);
    setActionError("");
    try {
      await onAction(approval.id, action);
    } catch {
      setActionError(t("approval.resolveFailed"));
    } finally {
      setActing(null);
    }
  }

  async function handleRetry() {
    setRetrying(true);
    try {
      await onRetry(approval.id);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <CardShell status={displayStatus}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <TypeTag type={approval.type} />
            <Separator className="h-3" orientation="vertical" />
            <StatusPill status={displayStatus} />
            <TimeMeta>{timeAgo(t, approval.createdAt)}</TimeMeta>
          </div>
          <p className="text-body text-foreground">{approval.description}</p>
          <p className="mt-1 text-aux text-muted-foreground">
            {t("approval.requestedBy")}{" "}
            <span className="text-foreground">{approval.requestedBy}</span>
            {approval.resolvedAt && (
              <>
                {" · "}
                {t("approval.resolved", {
                  when: timeAgo(t, approval.resolvedAt),
                })}
                {approval.resolvedBy && (
                  <>
                    {" "}
                    {t("approval.by")}{" "}
                    <span className="text-foreground">{approval.resolvedBy}</span>
                  </>
                )}
              </>
            )}
            {approval.executedAt && (
              <>
                {" "}
                ·{" "}
                {t("approval.executed", {
                  when: timeAgo(t, approval.executedAt),
                })}
              </>
            )}
          </p>
          {actionError && (
            <p role="alert" className="text-ui text-destructive">
              {actionError}
            </p>
          )}
          {approval.executionError && (
            <Alert variant="destructive" className="mt-2 px-3 py-2">
              <AlertDescription className="text-aux">
                <span>{t("approval.errorPrefix")}</span>
                {approval.executionError}
              </AlertDescription>
            </Alert>
          )}
          {approval.payload != null && (
            <Collapsible label={t("approval.payload")}>
              <JsonBlock value={approval.payload} />
            </Collapsible>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {isPending && (
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => handleAction("reject")}
                disabled={acting !== null}
              >
                {acting === "reject" ? t("approval.actions.pending") : t("approval.actions.reject")}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => handleAction("approve")}
                disabled={acting !== null}
              >
                {acting === "approve"
                  ? t("approval.actions.pending")
                  : t("approval.actions.approve")}
              </Button>
            </div>
          )}
          {canRetry && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? t("approval.actions.pending") : t("approval.actions.retry")}
            </Button>
          )}
        </div>
      </div>
    </CardShell>
  );
}

function ChildExecutionRow({ execution }: { execution: ActionExecution }) {
  const { t } = useTranslation("activity");
  return (
    <div className="rounded-8 border border-border bg-surface-muted p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-aux text-foreground" title={execution.actionName}>
          {artifactLocalName(execution.actionName)}
        </span>
        <StatusPill status={execution.status} />
        <TimeMeta>{timeAgo(t, execution.createdAt)}</TimeMeta>
        {execution.durationMs != null && (
          <TimeMeta>· {formatDuration(t, execution.durationMs)}</TimeMeta>
        )}
      </div>
      {execution.error && (
        <p className="mt-2 text-aux text-destructive-fg">
          <span>{t("execution.errorPrefix")}</span>
          {execution.error}
        </p>
      )}
      {execution.args != null && (
        <div className="mt-2">
          <JsonBlock value={execution.args} />
        </div>
      )}
    </div>
  );
}

function WebhookInvocationCard({ invocation }: { invocation: WebhookInvocation }) {
  const { t } = useTranslation("activity");
  return (
    <CardShell status={invocation.status}>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
          <TypeTag type="webhook" />
          <Separator className="h-3" orientation="vertical" />
          <span className="font-mono text-aux text-foreground" title={invocation.actionName}>
            {artifactLocalName(invocation.actionName)}
          </span>
          <StatusPill status={invocation.status} />
          <TimeMeta>{timeAgo(t, invocation.createdAt)}</TimeMeta>
        </div>
        <p className="text-body text-foreground">
          {t("webhook.received")}{" "}
          <span className="font-mono" title={invocation.actionName}>
            {artifactLocalName(invocation.actionName)}
          </span>
        </p>
        {/* The 13px mono ID otherwise expands this metadata row past the role's 16px line box. */}
        <p className="mt-1 h-4 text-aux text-muted-foreground">
          {t("webhook.executionLabel")}{" "}
          <span className="font-mono text-foreground">{invocation.executionId.slice(0, 12)}…</span>
          {invocation.finishedAt && (
            <>
              {" "}
              ·{" "}
              {t("webhook.finished", {
                when: timeAgo(t, invocation.finishedAt),
              })}
            </>
          )}
        </p>
        {invocation.callbackUrl && (
          <p className="mt-1 text-aux text-muted-foreground">
            {t("webhook.callbackLabel")}{" "}
            <span className="text-foreground">{invocation.callbackStatus}</span>
            {invocation.callbackResponseStatus != null &&
              t("webhook.callbackHttp", {
                status: invocation.callbackResponseStatus,
              })}
          </p>
        )}
        {invocation.error && (
          <Alert variant="destructive" className="mt-2 px-3 py-2">
            <AlertDescription className="text-aux">
              <span>{t("webhook.errorPrefix")}</span>
              {invocation.error}
            </AlertDescription>
          </Alert>
        )}
        {invocation.callbackError && (
          <Alert variant="destructive" className="mt-2 px-3 py-2">
            <AlertDescription className="text-aux">
              <span>{t("webhook.callbackErrorPrefix")}</span>
              {invocation.callbackError}
            </AlertDescription>
          </Alert>
        )}
        {invocation.args != null && (
          <Collapsible label={t("webhook.payload")}>
            <JsonBlock value={invocation.args} />
          </Collapsible>
        )}
      </div>
    </CardShell>
  );
}

function ExecutionGroupCard({
  group,
  onCancel,
}: {
  group: ExecutionGroup;
  onCancel: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation("activity");
  const [cancelling, setCancelling] = useState(false);
  const root = group.rootExecution;
  const canCancel = root.status === "running";
  const childCount = group.children.length;
  const childCountLabel = t(
    childCount === 1 ? "execution.childCountSingle" : "execution.childCountMultiple",
    { count: childCount },
  );

  async function handleCancel() {
    setCancelling(true);
    try {
      await onCancel(root.rootExecutionId);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <CardShell status={root.status}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <TypeTag type="action_execution" />
            <Separator className="h-3" orientation="vertical" />
            <span className="font-mono text-aux text-foreground" title={root.actionName}>
              {artifactLocalName(root.actionName)}
            </span>
            <StatusPill status={root.status} />
            <TimeMeta>{timeAgo(t, root.createdAt)}</TimeMeta>
            {root.durationMs != null && <TimeMeta>· {formatDuration(t, root.durationMs)}</TimeMeta>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-aux text-muted-foreground">
            <span>{childCountLabel}</span>
            {root.initiator && (
              <span>
                {t("execution.initiatedBy")}{" "}
                <span className="text-foreground">{root.initiator}</span>
              </span>
            )}
            {root.actor && (
              <span>
                {t("execution.performedBy")}{" "}
                <span className="text-foreground">{actorLabel(t, root.actor)}</span>
              </span>
            )}
          </div>
          {root.cancelRequestedAt && root.status === "running" && (
            <p className="mt-2 text-aux text-warning-fg">
              {t("execution.cancellationRequested", {
                when: timeAgo(t, root.cancelRequestedAt),
              })}
            </p>
          )}
          {root.error && (
            <Alert variant="destructive" className="mt-2 px-3 py-2">
              <AlertDescription className="text-aux">
                <span>{t("execution.errorPrefix")}</span>
                {root.error}
              </AlertDescription>
            </Alert>
          )}
          {root.cancellationReason && root.status === "cancelled" && (
            <p className="mt-2 text-aux text-muted-foreground">{root.cancellationReason}</p>
          )}
          <Collapsible label={t("execution.details")}>
            <div className="space-y-3">
              <div className="font-mono text-aux text-muted-foreground">
                <span className="text-subtle-foreground">{t("execution.rootId")}</span>{" "}
                {root.rootExecutionId}
              </div>
              {root.args != null && (
                <div>
                  <div className="mb-1 text-aux text-subtle-foreground">{t("execution.args")}</div>
                  <JsonBlock value={root.args} />
                </div>
              )}
              {childCount > 0 && (
                <div>
                  <div className="mb-2 text-aux text-subtle-foreground">
                    {t("execution.children")}
                  </div>
                  <div className="space-y-2">
                    {group.children.map((child) => (
                      <ChildExecutionRow key={child.id} execution={child} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Collapsible>
        </div>
        {canCancel && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? t("execution.actions.pending") : t("execution.actions.cancel")}
          </Button>
        )}
      </div>
    </CardShell>
  );
}

function getItemDate(item: ActivityItem): string {
  if (item.kind === "approval") return item.data.createdAt;
  if (item.kind === "execution_group") return item.data.rootExecution.createdAt;
  return item.data.createdAt;
}

// Filter pill order; labels resolved at render via t("page.filters.<value>").
const FILTER_VALUES: StatusFilter[] = [
  "all",
  "pending",
  "running",
  "success",
  "error",
  "approved",
  "rejected",
  "auto_approved",
  "pending_approval",
  "cancelled",
];

function StatTile({
  value,
  label,
  accent,
  live,
}: {
  value: number;
  label: string;
  accent: string;
  live?: boolean;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${accent}`}
            style={
              live ? { animation: "rome-activity-pulse 1.8s ease-in-out infinite" } : undefined
            }
          />
          <span className="text-aux text-muted-foreground">{label}</span>
        </div>
        <div className="text-title tabular-nums text-foreground">{value}</div>
      </CardContent>
    </Card>
  );
}

export default function ActivityPage() {
  const { t } = useTranslation("activity");
  const approvalsQuery = useApprovals();
  const approvals = approvalsQuery.data ?? [];
  const resolveApproval = useResolveApproval();
  const [executionGroups, setExecutionGroups] = useState<ExecutionGroup[]>([]);
  const [webhookInvocations, setWebhookInvocations] = useState<WebhookInvocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [offset, setOffset] = useState(0);
  const [lastFetchedAt, setLastFetchedAt] = useState<number>(Date.now());
  const [, setTick] = useState(0);
  const limit = 50;
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      params.set("offset", String(offset));

      const [executionsRes, webhooksRes] = await Promise.all([
        fetch(`/api/action-executions?${params}`, { signal: ac.signal }),
        fetch(`/api/webhook-invocations?${params}`, { signal: ac.signal }),
      ]);

      if (executionsRes.ok) setExecutionGroups(await executionsRes.json());
      if (webhooksRes.ok) setWebhookInvocations(await webhooksRes.json());
      setLastFetchedAt(Date.now());
    } catch {
      // aborted or network error — leave state as-is
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchData]);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);

  async function handleAction(id: string, action: "approve" | "reject") {
    await resolveApproval.mutateAsync({ id, action });
    await fetchData();
  }

  async function handleRetry(id: string) {
    const res = await fetch(`/api/approvals/${id}/retry`, { method: "POST" });
    if (res.ok) {
      await fetchData();
      await approvalsQuery.refetch();
    }
  }

  async function handleCancel(id: string) {
    const res = await fetch(`/api/action-executions/${id}/cancel`, {
      method: "POST",
    });
    if (res.ok) {
      await fetchData();
      await approvalsQuery.refetch();
    }
  }

  const allItems: ActivityItem[] = useMemo(
    () => [
      ...approvals.map((a) => ({ kind: "approval" as const, data: a })),
      ...executionGroups.map((g) => ({
        kind: "execution_group" as const,
        data: g,
      })),
      ...webhookInvocations.map((w) => ({
        kind: "webhook_invocation" as const,
        data: w,
      })),
    ],
    [approvals, executionGroups, webhookInvocations],
  );

  const sorted = useMemo(() => {
    const filtered = allItems.filter((item) => matchesActivityFilter(item, statusFilter));
    return filtered.sort(
      (a, b) => new Date(getItemDate(b)).getTime() - new Date(getItemDate(a)).getTime(),
    );
  }, [allItems, statusFilter]);

  const stats = useMemo(() => {
    const pendingApprovals = approvals.filter((a) => a.status === "pending").length;
    const running = executionGroups.filter((g) => g.rootExecution.status === "running").length;
    const errors = allItems.filter(hasActivityError).length;
    const events = allItems.length;
    return { pendingApprovals, running, errors, events };
  }, [approvals, executionGroups, allItems]);

  const updatedLabel = timeAgo(t, new Date(lastFetchedAt).toISOString());
  const itemKey = (item: ActivityItem): string => {
    if (item.kind === "approval") return `approval-${item.data.id}`;
    if (item.kind === "webhook_invocation") return `webhook-${item.data.executionId}`;
    return `exec-${item.data.rootExecution.rootExecutionId}`;
  };

  return (
    <PageShell>
      <PageBody>
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-title text-foreground">{t("page.title")}</h1>
            <div className="mt-1 flex items-center gap-2 text-aux text-muted-foreground">
              <span
                className="h-1.5 w-1.5 rounded-full bg-success"
                style={{
                  animation: "rome-activity-breathe 2.4s ease-in-out infinite",
                }}
                aria-hidden="true"
              />
              <span>{t("page.liveUpdated", { when: updatedLabel })}</span>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void fetchData();
              void approvalsQuery.refetch();
            }}
          >
            {t("page.refresh")}
          </Button>
        </div>

        {/* Stats */}
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            value={stats.pendingApprovals}
            label={t("page.stats.pending")}
            accent="bg-warning"
            live={stats.pendingApprovals > 0}
          />
          <StatTile
            value={stats.running}
            label={t("page.stats.running")}
            accent="bg-info"
            live={stats.running > 0}
          />
          <StatTile value={stats.errors} label={t("page.stats.errors")} accent="bg-destructive" />
          <StatTile value={stats.events} label={t("page.stats.events")} accent="bg-primary" />
        </section>

        {/* Pending callout */}
        {stats.pendingApprovals > 0 && statusFilter === "all" && (
          <button
            onClick={() => setStatusFilter("pending")}
            className="flex w-full items-center justify-between gap-3 rounded-8 border border-warning-border bg-warning-bg px-4 py-2 text-left transition-colors hover:bg-warning-bg/70"
          >
            <div className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 rounded-full bg-warning"
                style={{
                  animation: "rome-activity-pulse 1.6s ease-in-out infinite",
                }}
                aria-hidden="true"
              />
              <span className="text-ui text-warning-fg">
                <span>
                  {t(
                    stats.pendingApprovals === 1
                      ? "page.pendingCallout.single"
                      : "page.pendingCallout.multiple",
                    { count: stats.pendingApprovals },
                  )}
                </span>{" "}
                {t("page.pendingCallout.suffix")}
              </span>
            </div>
            <span className="text-aux text-warning-fg">{t("page.pendingCallout.cta")}</span>
          </button>
        )}

        {/* Filter pills */}
        <div className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1">
          {FILTER_VALUES.map((value) => {
            const active = statusFilter === value;
            return (
              <button
                key={value}
                onClick={() => setStatusFilter(value)}
                className={`shrink-0 rounded-full px-3 py-1 text-badge transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "border border-border-strong bg-surface text-foreground hover:bg-surface-muted"
                }`}
              >
                {t(`page.filters.${value}`)}
              </button>
            );
          })}
        </div>

        <ApprovalHistoryButton />

        {/* Content */}
        {approvalsQuery.isError && (
          <Alert variant="destructive">
            <AlertDescription>{t("pairing.loadFailed")}</AlertDescription>
          </Alert>
        )}
        {loading || approvalsQuery.isLoading ? (
          <div className="py-12 text-center">
            <div
              className="mx-auto mb-3 h-5 w-5 rounded-full border-2 border-border-strong border-t-gray-800"
              style={{ animation: "spin 0.9s linear infinite" }}
              aria-hidden="true"
            />
            <p className="text-ui text-muted-foreground">{t("page.loading")}</p>
          </div>
        ) : sorted.length === 0 ? (
          <div className="rounded-12 border border-dashed border-border-strong bg-surface/50 py-12 text-center">
            <p className="text-ui text-muted-foreground">{t("page.empty.title")}</p>
            <p className="mt-1 text-aux text-subtle-foreground">{t("page.empty.hint")}</p>
          </div>
        ) : (
          <>
            <div className="space-y-3">
              {sorted.map((item, i) => (
                <div
                  key={itemKey(item)}
                  style={{
                    animationDelay: `${Math.min(i, 8) * 35}ms`,
                    animationFillMode: "both",
                  }}
                >
                  {item.kind === "approval" ? (
                    pairingPayload(item.data) ? (
                      <PairingApproval approval={item.data} />
                    ) : (
                      <ApprovalCard
                        approval={item.data}
                        onAction={handleAction}
                        onRetry={handleRetry}
                      />
                    )
                  ) : item.kind === "webhook_invocation" ? (
                    <WebhookInvocationCard invocation={item.data} />
                  ) : (
                    <ExecutionGroupCard group={item.data} onCancel={handleCancel} />
                  )}
                </div>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
              >
                {t("page.pagination.previous")}
              </Button>
              <span className="text-aux tabular-nums text-muted-foreground">
                {t("page.pagination.page", {
                  n: Math.floor(offset / limit) + 1,
                })}
              </span>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOffset(offset + limit)}
                disabled={executionGroups.length < limit && webhookInvocations.length < limit}
              >
                {t("page.pagination.next")}
              </Button>
            </div>
          </>
        )}
      </PageBody>
    </PageShell>
  );
}
