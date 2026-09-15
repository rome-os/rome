import { useTranslation } from "react-i18next";
import type { ApprovalCardStatus, ApprovalPreviewPayload } from "@/lib/chat-types";
import { Button } from "@/components/ui/button";
import { artifactLocalName } from "@/lib/artifact-name";
import { ApprovalPreviewBody } from "./ApprovalPreviewBody";
import { useApprovalCard } from "./use-approval-card";

const STATUS_BADGE_TONES: Record<ApprovalCardStatus, string> = {
  pending: "bg-warning-bg text-warning-fg border-warning-border",
  approved: "bg-success-bg text-success-fg border-success-border",
  executing: "bg-info-bg text-info-fg border-info-border",
  executed: "bg-success-bg text-success-fg border-success-border",
  rejected: "bg-destructive-bg text-destructive-fg border-destructive-border",
  failed: "bg-destructive-bg text-destructive-fg border-destructive-border",
};

export function ApprovalCard({
  approvalId,
  actionName,
  preview,
  status: initialStatus,
  onResolved,
}: {
  approvalId: string;
  actionName?: string;
  preview: ApprovalPreviewPayload;
  status: ApprovalCardStatus;
  onResolved: () => void;
}) {
  const { t } = useTranslation("chat");
  const { status, isTerminal, record, submitting, submitError, submit } = useApprovalCard({
    approvalId,
    initialStatus,
    onResolved,
  });
  const resolvedActionName = actionName
    ? artifactLocalName(actionName)
    : t("approvals.fallbackActionName");
  const statusLabel = t(`approvals.status.${status}`);
  const headerTitle =
    status === "pending" ? t("approvals.headerPending") : t("approvals.headerResolved");

  return (
    <div className="mb-3 overflow-hidden rounded-12 border border-warning-border bg-warning-bg/60">
      <div className="flex items-center justify-between border-b border-warning-border bg-warning-bg px-4 py-2">
        <div className="flex items-center gap-2 text-ui text-warning-fg">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 17c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          {headerTitle}
        </div>
        <span className={`rounded-full border px-2 py-1 text-badge ${STATUS_BADGE_TONES[status]}`}>
          {statusLabel}
        </span>
      </div>
      <div className="space-y-2 px-4 py-3 text-ui text-foreground">
        <div className="text-aux text-subtle-foreground">{resolvedActionName}</div>
        <ApprovalPreviewBody preview={preview} />
      </div>
      {!isTerminal && status === "pending" && (
        <div className="flex items-center justify-end gap-2 border-t border-warning-border bg-surface/60 px-4 py-2">
          {submitError && (
            <span className="mr-auto text-aux text-destructive-fg">{submitError}</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => submit("reject")}
            disabled={submitting !== null}
          >
            {submitting === "reject"
              ? t("approvals.actions.rejecting")
              : t("approvals.actions.reject")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => submit("approve")}
            disabled={submitting !== null}
          >
            {submitting === "approve"
              ? t("approvals.actions.approving")
              : t("approvals.actions.approve")}
          </Button>
        </div>
      )}
      {status === "failed" && record?.executionError && (
        <div className="border-t border-destructive-border bg-destructive-bg/60 px-4 py-2 text-aux text-destructive-fg">
          {record.executionError}
        </div>
      )}
      {(status === "approved" || status === "executing") && (
        <div className="border-t border-success-border bg-success-bg/60 px-4 py-2 text-aux text-success-fg">
          {t("approvals.footer.approvedRunning")}
        </div>
      )}
      {status === "executed" && (
        <div className="border-t border-success-border bg-success-bg/60 px-4 py-2 text-aux text-success-fg">
          {t("approvals.footer.executedSuccess")}
        </div>
      )}
      {status === "rejected" && (
        <div className="border-t border-destructive-border bg-destructive-bg/60 px-4 py-2 text-aux text-destructive-fg">
          {t("approvals.footer.rejectedNotice")}
        </div>
      )}
    </div>
  );
}
