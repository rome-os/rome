import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PreviewPayload } from "@/lib/chat-types";

type SecretAccess = Extract<PreviewPayload, { kind: "secret_access" }>;

/**
 * A request to use one vault secret for a while: the name, how long, why, and
 * the guardian's two answers. Once decided it folds to one line (see
 * `secretAccessOutcome`); opened from there it shows the same card without the
 * answers. A neutral card, not the generic approval's warning frame: the
 * request is routine and reversible, and the name says what it is.
 */
export function SecretAccessCard({
  preview,
  header,
  pending,
  awaiting,
  failure,
  submitting,
  submitError,
  submit,
}: {
  preview: SecretAccess;
  header?: ReactNode;
  /** The server confirmed the approval is pending, so the sidebar and tab may ask for the guardian. */
  pending: boolean;
  /** The card still takes an answer. */
  awaiting: boolean;
  failure?: string | null;
  submitting: "approve" | "reject" | null;
  submitError: string | null;
  submit: (intent: "approve" | "reject") => void;
}) {
  const { t } = useTranslation("chat");
  const minutes = preview.ttlMinutes;
  return (
    <div
      tabIndex={-1}
      data-chat-card
      data-chat-pending-card={pending ? "approval" : undefined}
      className="mb-3 w-full max-w-md rounded-12 border border-border bg-surface px-4 py-3"
    >
      {header ? <div className="flex min-w-0 flex-col pb-2">{header}</div> : null}
      <div className="flex items-start gap-3">
        <span className="flex h-5 shrink-0 items-center">
          <KeyRound className="size-4 text-subtle-foreground" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 font-mono text-section text-foreground wrap-anywhere">
              {preview.name}
            </span>
            <Badge variant="muted">{t("approvals.secretAccess.duration", { minutes })}</Badge>
          </div>
          <p className="mt-1 text-ui text-foreground wrap-anywhere">{preview.reason}</p>
        </div>
      </div>
      {awaiting && (
        <div className="mt-3 flex items-center justify-end gap-2">
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
              : t("approvals.secretAccess.allow", { minutes })}
          </Button>
        </div>
      )}
      {failure && <p className="mt-2 text-aux text-destructive-fg wrap-anywhere">{failure}</p>}
    </div>
  );
}
