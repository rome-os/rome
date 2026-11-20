import { VAULT_PIN_PATTERN } from "@rome/api-types/vault";
import { KeyRound } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PinInput, useErrorCount } from "@/components/vault-pin-input";
import type { PreviewPayload } from "@/lib/chat-types";
import { secretNamesText } from "./secret-names";

type SecretAccess = Extract<PreviewPayload, { kind: "secret_access" }>;

/**
 * A request to use one or several vault secrets for a while: the names, how
 * long, why, and the guardian's two answers. Once decided it folds to one line (see
 * `secretAccessOutcome`); opened from there it shows the same card without the
 * answers. A neutral card, not the generic approval's warning frame: the
 * request is routine and reversible, and the names say what it is. Allowing
 * takes the guardian's PIN, which lives in this component's state only and is
 * cleared on every submit.
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
  /** `pin` goes with an approve only. */
  submit: (intent: "approve" | "reject", pin?: string) => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const [pin, setPin] = useState("");
  const errorCount = useErrorCount(submitError);
  const minutes = preview.ttlMinutes;
  const allow = () => {
    if (!VAULT_PIN_PATTERN.test(pin) || submitting !== null) return;
    setPin("");
    submit("approve", pin);
  };
  const body = (
    <div className="flex items-start gap-3">
      <span className="flex h-5 shrink-0 items-center">
        <KeyRound className="size-4 text-subtle-foreground" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 font-mono text-section text-foreground wrap-anywhere">
            {secretNamesText(t, preview)}
          </span>
          <Badge variant="muted">{t("approvals.secretAccess.duration", { minutes })}</Badge>
        </div>
        <p className="mt-1 text-ui text-foreground wrap-anywhere">{preview.reason}</p>
        {awaiting && (
          <div className="mt-3">
            <PinInput
              size="sm"
              aria-label={tCommon("vaultPin.label")}
              value={pin}
              onChange={setPin}
              disabled={submitting !== null}
              invalid={Boolean(submitError)}
              shakeKey={errorCount}
            />
            {submitError && (
              <p role="alert" className="mt-2 text-aux text-destructive-fg">
                {submitError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
  return (
    <div
      tabIndex={-1}
      data-chat-card
      data-chat-pending-card={pending ? "approval" : undefined}
      className="mb-3 w-full max-w-md rounded-12 border border-border bg-surface px-4 py-3"
    >
      {header ? <div className="flex min-w-0 flex-col pb-2">{header}</div> : null}
      {awaiting ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            allow();
          }}
        >
          {body}
          {/* The answers sit on their own row at every width. */}
          <div className="mt-3 flex items-center justify-end gap-2">
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
              type="submit"
              size="sm"
              disabled={submitting !== null || !VAULT_PIN_PATTERN.test(pin)}
            >
              {submitting === "approve"
                ? t("approvals.actions.approving")
                : t("approvals.secretAccess.allow", { minutes })}
            </Button>
          </div>
        </form>
      ) : (
        body
      )}
      {failure && <p className="mt-2 text-aux text-destructive-fg wrap-anywhere">{failure}</p>}
    </div>
  );
}
