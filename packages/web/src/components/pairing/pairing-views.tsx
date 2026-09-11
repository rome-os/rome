import { cloneElement, useRef, type ReactElement, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, ChevronRight, Copy, CircleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

interface PairingAccount {
  name: string;
  accountId: string;
  channel: string;
}

export interface PairingRequestCardProps extends PairingAccount {
  createdAt: string;
  expiresAt: number;
  status: "pending" | "approved" | "rejected" | "expired";
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  busy?: "approve" | "reject" | null;
  error?: boolean;
  onApprove: () => void;
  onReject: () => void;
  children?: ReactNode;
}

export function PairingRequestCard({
  name,
  accountId,
  channel,
  createdAt,
  expiresAt,
  status,
  resolvedBy,
  resolvedAt,
  busy,
  error,
  onApprove,
  onReject,
  children,
}: PairingRequestCardProps) {
  const { t, i18n } = useTranslation("activity");
  const locale = i18n.resolvedLanguage;
  const minutes = Math.max(0, Math.round((expiresAt - new Date(createdAt).getTime()) / 60_000));
  const duration = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: minutes >= 60 ? "hour" : "minute",
    unitDisplay: "long",
    maximumFractionDigits: 1,
  }).format(minutes >= 60 ? minutes / 60 : minutes);
  return (
    <section
      aria-label={t("pairing.account", { account: `${name} (${accountId})` })}
      className="@container flex min-w-0 flex-col gap-3 rounded-8 border border-border bg-surface p-4 text-foreground"
    >
      <div className="grid grid-cols-1 gap-3 @min-[28rem]:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="break-words text-title [overflow-wrap:anywhere]">{name}</h3>
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        tabIndex={0}
                        aria-label={`ID ${accountId}`}
                        className="min-w-0 max-w-full gap-1 whitespace-nowrap text-muted-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {accountId.length > 24 ? (
                          <>
                            <span className="shrink-0">ID</span>
                            <span className="flex min-w-0">
                              <span className="truncate">{accountId.slice(0, 12)}</span>
                              <span className="shrink-0">…{accountId.slice(-8)}</span>
                            </span>
                          </>
                        ) : (
                          `ID ${accountId}`
                        )}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent
                      sideOffset={4}
                      className="max-w-[min(20rem,calc(100vw-2rem))] break-all"
                    >
                      {accountId}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="text-ui text-muted-foreground">{channel}</p>
            </div>
          </div>
          <p className="text-aux text-muted-foreground">
            {t("pairing.requested", { time: new Date(createdAt).toLocaleString(locale) })}
            {" · "}
            {t("pairing.validity", { duration })}
          </p>
        </div>
        {status === "pending" ? (
          <div
            className="flex flex-wrap items-start gap-2 @min-[28rem]:self-center"
            aria-busy={!!busy}
          >
            <Button disabled={!!busy} onClick={onApprove}>
              {t(busy === "approve" ? "pairing.approving" : "pairing.approve")}
            </Button>
            <Button variant="outline" disabled={!!busy} onClick={onReject}>
              {t(busy === "reject" ? "pairing.rejecting" : "pairing.reject")}
            </Button>
          </div>
        ) : (
          <div className="flex min-h-[var(--control-h-md)] self-start items-center @min-[28rem]:self-center @min-[28rem]:justify-end">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    tabIndex={resolvedBy ? 0 : undefined}
                    className="shrink-0 gap-1 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {status === "approved" && <Check className="size-3.5" aria-hidden="true" />}
                    {t(`pairing.${status}`)}
                  </Badge>
                </TooltipTrigger>
                {resolvedBy && (
                  <TooltipContent
                    sideOffset={4}
                    className="max-w-[min(20rem,calc(100vw-2rem))] break-words"
                  >
                    {t("pairing.resolved", {
                      actor: resolvedBy,
                      time: resolvedAt ? new Date(resolvedAt).toLocaleString(locale) : "",
                    })}
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {t("pairing.resolveFailed")}
        </p>
      )}
      {status === "pending" && children && (
        <div className="border-t border-border pt-2 has-[details:not([open])]:-mb-2">
          {children}
        </div>
      )}
    </section>
  );
}

export type PairingCodeState =
  | { kind: "ready"; code: string; copied: boolean; error?: boolean }
  | { kind: "loading" | "error" | "locked" };

export interface PairingCodeSectionProps {
  channel: string;
  accountName: string;
  state: PairingCodeState;
  defaultOpen?: boolean;
  onCopy: () => void;
  onRetry: () => void;
}

export function PairingCodeSection({
  channel,
  accountName,
  state,
  defaultOpen = false,
  onCopy,
  onRetry,
}: PairingCodeSectionProps) {
  const { t } = useTranslation("activity");
  return (
    <details className="group" open={defaultOpen || undefined}>
      <summary className="flex min-h-[var(--control-h-md)] cursor-pointer list-none items-center gap-2 rounded-4 text-ui text-muted-foreground hover:text-foreground focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 shrink-0 group-open:rotate-90" aria-hidden="true" />
        {t("pairing.codeAlternative")}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {state.kind === "ready" ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-4 bg-surface-muted p-3">
              <code className="break-all text-title tabular-nums" aria-label={t("pairing.code")}>
                {state.code}
              </code>
              <Button
                variant="outline"
                onClick={onCopy}
                aria-label={t(state.copied ? "pairing.copied" : "pairing.copy")}
              >
                {state.copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {t("pairing.copy")}
              </Button>
            </div>
            <span role="status" className="sr-only">
              {state.copied ? t("pairing.copied") : ""}
            </span>
            {state.error && (
              <p role="alert" className="text-ui text-destructive">
                {t("pairing.copyFailed")}
              </p>
            )}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p
              role={state.kind === "error" ? "alert" : "status"}
              className={state.kind === "error" ? "text-ui text-destructive" : "text-ui"}
            >
              {t(
                state.kind === "locked"
                  ? "pairing.locked"
                  : state.kind === "error"
                    ? "pairing.codeLoadFailed"
                    : "pairing.loading",
              )}
            </p>
            {state.kind === "error" && (
              <Button variant="outline" onClick={onRetry}>
                {t("pairing.retry")}
              </Button>
            )}
          </div>
        )}
        <p className="break-words text-ui text-muted-foreground [overflow-wrap:anywhere]">
          {t("pairing.destination", { channel, account: accountName || t("pairing.thisAccount") })}
        </p>
      </div>
    </details>
  );
}

export interface PairingConfirmationDialogProps extends PairingAccount {
  open: boolean;
  busy?: boolean;
  error?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function PairingConfirmationDialog({
  open,
  name,
  accountId,
  channel,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: PairingConfirmationDialogProps) {
  const { t } = useTranslation("activity");
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onCancel();
      }}
      initialFocusRef={cancelRef}
      modal={busy}
      className="max-w-[calc(100vw-2rem)] sm:max-w-lg"
    >
      <DialogHeader>
        <DialogTitle>{t("pairing.confirmTitle")}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <DialogDescription className="break-words [overflow-wrap:anywhere]">
          {t("pairing.confirmBody", { channel, account: `${name} (${accountId})` })}
        </DialogDescription>
        {error && (
          <p role="alert" className="text-ui text-destructive">
            {t("pairing.resolveFailed")}
          </p>
        )}
      </DialogBody>
      <DialogFooter aria-busy={busy} className="flex-wrap">
        <Button ref={cancelRef} variant="outline" disabled={busy} onClick={onCancel}>
          {t("pairing.cancel")}
        </Button>
        <Button disabled={busy} onClick={onConfirm}>
          {t(busy ? "pairing.approving" : "pairing.approve")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export interface PairingRequestsSectionProps {
  state: "loading" | "error" | "empty" | "ready";
  activityLink: ReactElement<{ children?: ReactNode }>;
  onRetry: () => void;
  children?: ReactNode;
}

export function PairingRequestsSection({
  state,
  activityLink,
  onRetry,
  children,
}: PairingRequestsSectionProps) {
  const { t } = useTranslation("activity");
  return (
    <section className="flex flex-col gap-3" aria-label={t("pairing.title")}>
      <div className="flex flex-col gap-2">
        <h2 className="text-title">{t("pairing.title")}</h2>
        <p className="text-ui text-muted-foreground">{t("pairing.description")}</p>
      </div>
      {state === "error" ? (
        <div className="flex flex-col items-start gap-3 rounded-8 border border-border bg-surface p-4">
          <p role="alert" className="flex items-center gap-2 text-ui text-destructive">
            <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("pairing.loadFailed")}
          </p>
          <Button variant="outline" onClick={onRetry}>
            {t("pairing.retry")}
          </Button>
        </div>
      ) : state === "loading" ? (
        <div role="status">
          <span className="sr-only">{t("pairing.loading")}</span>
          <div
            aria-hidden="true"
            className="@container rounded-8 border border-border bg-surface p-4"
          >
            <div className="grid grid-cols-1 gap-3 motion-safe:animate-pulse @min-[28rem]:grid-cols-[minmax(0,1fr)_auto] [&_[data-slot=skeleton]]:animate-none">
              <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-6 w-40 max-w-full" />
                  <Skeleton className="h-4 w-20" />
                </div>
                <Skeleton className="h-4 w-full max-w-64" />
              </div>
              <div className="flex gap-2 @min-[28rem]:self-center">
                <Skeleton className="h-[var(--control-h-md)] w-16 rounded-[var(--control-r-md)]" />
                <Skeleton className="h-[var(--control-h-md)] w-16 rounded-[var(--control-r-md)]" />
              </div>
            </div>
          </div>
        </div>
      ) : state === "empty" ? (
        <p className="rounded-8 border border-dashed border-border p-4 text-ui text-muted-foreground">
          <Trans t={t} i18nKey="pairing.empty" components={{ activity: activityLink }} />
        </p>
      ) : (
        children
      )}
      {state !== "empty" && (
        <div className="text-ui">{cloneElement(activityLink, {}, t("pairing.viewActivity"))}</div>
      )}
    </section>
  );
}

export interface ApprovalHistoryControlProps {
  hasMore: boolean;
  loading?: boolean;
  error?: boolean;
  onLoad: () => void;
}

export function ApprovalHistoryControl({
  hasMore,
  loading,
  error,
  onLoad,
}: ApprovalHistoryControlProps) {
  const { t } = useTranslation("activity");
  if (!hasMore) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      {error && (
        <p role="alert" className="text-ui text-destructive">
          {t("pairing.loadFailed")}
        </p>
      )}
      <Button variant="outline" disabled={loading} onClick={onLoad}>
        {t(loading ? "pairing.loading" : "pairing.loadHistory")}
      </Button>
    </div>
  );
}
