import { ChevronDown, ChevronUp, ShieldCheck } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import {
  expiryPresetToIso,
  GROUP_ORDER,
  type OperationGroupKey,
  operationGroupKey,
  operationI18nKey,
} from "@/components/connections/connection-operation-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { PreviewPayload } from "@/lib/chat-types";

type ConnectionAccess = Extract<PreviewPayload, { kind: "connection_access" }>;
type ExpiryPreset = "never" | "7d" | "30d";

/**
 * A calm, reversible authorization card shown in chat when an agent asks for an
 * installed app to access a connected service. Once decided it folds to one line
 * (see `connectionAccessOutcome`); expanded from there it renders read-only.
 */
export function ConnectionAccessCard({
  preview,
  header,
  pending,
  awaiting,
  failure,
  submitting,
  submitError,
  submit,
}: {
  preview: ConnectionAccess;
  header?: ReactNode;
  pending: boolean;
  awaiting: boolean;
  failure?: string | null;
  submitting: "approve" | "reject" | null;
  submitError: string | null;
  submit: (intent: "approve" | "reject", options?: { expiresAt: string | null }) => void;
}) {
  const { t } = useTranslation("chat");
  const { t: tSettings } = useTranslation("settings", { keyPrefix: "connectionAppAccess" });
  const [expiry, setExpiry] = useState<ExpiryPreset>("never");
  const [expanded, setExpanded] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<OperationGroupKey, ConnectionAccess["operations"]>();
    for (const op of preview.operations) {
      const group = operationGroupKey(op.name, preview.connectionKind);
      const list = map.get(group) ?? [];
      list.push(op);
      map.set(group, list);
    }
    return GROUP_ORDER.filter((key) => map.has(key)).map((key) => ({
      key,
      operations: map.get(key)!,
    }));
  }, [preview.connectionKind, preview.operations]);

  const readCount = preview.operations.filter((op) => op.sideEffect === "read-only").length;
  const writeCount = preview.operations.length - readCount;

  const summaryParts: string[] = [];
  if (readCount > 0) {
    summaryParts.push(t("approvals.connectionAccess.readCount", { count: readCount }));
  }
  if (writeCount > 0) {
    summaryParts.push(t("approvals.connectionAccess.writeCount", { count: writeCount }));
  }

  return (
    <div
      tabIndex={-1}
      data-chat-card
      data-chat-pending-card={pending ? "approval" : undefined}
      className="mb-3 w-full max-w-md rounded-12 border border-border bg-surface px-4 py-3.5"
    >
      {header ? <div className="flex min-w-0 flex-col pb-2">{header}</div> : null}

      <div className="flex items-start gap-3">
        <ConnectionBrandBadge connection={preview.connectionKind} className="mt-0.5 h-8 w-8" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-section font-medium text-foreground wrap-anywhere">
              {t("approvals.connectionAccess.title", {
                appName: preview.appName,
                connectionLabel: preview.connectionLabel,
              })}
            </span>
          </div>
          <p className="mt-1 text-ui text-muted-foreground wrap-anywhere">{preview.reason}</p>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {grouped.map(({ key }) => (
              <Badge key={key} variant="muted" className="font-normal">
                {tSettings(`groups.${key}`)}
              </Badge>
            ))}
            {summaryParts.length > 0 && (
              <span className="text-aux text-muted-foreground">{summaryParts.join(" · ")}</span>
            )}
          </div>

          {writeCount > 0 && (
            <p className="mt-2 flex items-center gap-1.5 text-aux text-muted-foreground">
              <ShieldCheck className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden />
              <span>{t("approvals.connectionAccess.writeApprovalNote")}</span>
            </p>
          )}

          {preview.operations.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                className="inline-flex items-center gap-1 text-aux text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>
                  {expanded
                    ? t("approvals.connectionAccess.hideDetails")
                    : t("approvals.connectionAccess.showDetails", {
                        count: preview.operations.length,
                      })}
                </span>
                {expanded ? (
                  <ChevronUp className="size-3.5" aria-hidden />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden />
                )}
              </button>

              {expanded && (
                <ul className="mt-2 space-y-1.5 rounded-8 border border-border-subtle bg-background/60 px-3 py-2">
                  {preview.operations.map((op) => {
                    const key = operationI18nKey(op.name);
                    const label = key
                      ? tSettings(`operations.${key}.title`, { defaultValue: op.name })
                      : op.name;
                    return (
                      <li
                        key={op.name}
                        className="flex items-center justify-between gap-2 text-aux"
                      >
                        <span className="min-w-0 truncate text-foreground">{label}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {op.sideEffect === "write"
                            ? t("approvals.connectionAccess.writeBadge")
                            : t("approvals.connectionAccess.readBadge")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      {awaiting && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle pt-3">
          <div className="flex items-center gap-2">
            <span className="text-aux text-muted-foreground">
              {t("approvals.connectionAccess.expiryLabel")}
            </span>
            <Select
              value={expiry}
              onValueChange={(value) => setExpiry(value as ExpiryPreset)}
              disabled={submitting !== null}
            >
              <SelectTrigger
                aria-label={t("approvals.connectionAccess.expiryLabel")}
                className="h-7 w-auto min-w-[6.5rem] text-aux"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="never">{tSettings("never")}</SelectItem>
                <SelectItem value="7d">{tSettings("sevenDays")}</SelectItem>
                <SelectItem value="30d">{tSettings("thirtyDays")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
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
              onClick={() => submit("approve", { expiresAt: expiryPresetToIso(expiry) })}
              disabled={submitting !== null}
            >
              {submitting === "approve"
                ? t("approvals.actions.approving")
                : t("approvals.connectionAccess.allow")}
            </Button>
          </div>
        </div>
      )}

      {submitError && (
        <p role="alert" className="mt-2 text-aux text-destructive-fg wrap-anywhere">
          {submitError}
        </p>
      )}
      {failure && <p className="mt-2 text-aux text-destructive-fg wrap-anywhere">{failure}</p>}
    </div>
  );
}
