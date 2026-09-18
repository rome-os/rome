import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Check, ChevronRight, Copy, CircleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger, PopoverArrow } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogHeader,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";

const ID_TRUNCATION_THRESHOLD = 24;
const ID_PREFIX_LENGTH = 12;
const ID_SUFFIX_LENGTH = 8;
const detailSurface = {
  side: "top" as const,
  align: "center" as const,
  sideOffset: 4,
  collisionPadding: 16,
  className:
    "block w-fit max-w-[min(20rem,calc(100vw-2rem))] break-all rounded-8 bg-foreground px-3 py-1 text-aux text-background shadow-none ring-0",
};

function PairingDetail({
  label,
  detail,
  children,
  className = "",
}: {
  label: string;
  detail: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip open={!open && tooltipOpen} onOpenChange={setTooltipOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Badge
              asChild
              variant="outline"
              className={`min-w-0 max-w-full gap-1 whitespace-nowrap outline-none outline-1 outline-transparent focus-visible:outline-solid focus-visible:-outline-offset-1 focus-visible:outline-ring/50 ${className}`}
            >
              <button type="button" aria-label={label}>
                {children}
              </button>
            </Badge>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent {...detailSurface}>{detail}</TooltipContent>
      </Tooltip>
      <PopoverContent {...detailSurface} aria-label={label}>
        {detail}
        <PopoverArrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 bg-foreground fill-foreground" />
      </PopoverContent>
    </Popover>
  );
}

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
    <TooltipProvider delayDuration={150}>
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
                  {accountId.length > ID_TRUNCATION_THRESHOLD ? (
                    <PairingDetail
                      label={`ID ${accountId}`}
                      detail={accountId}
                      className="text-muted-foreground"
                    >
                      <span className="shrink-0">ID</span>
                      <span className="flex min-w-0" aria-hidden="true">
                        <span className="overflow-hidden">
                          {accountId.slice(0, ID_PREFIX_LENGTH)}
                        </span>
                        <span className="shrink-0">…{accountId.slice(-ID_SUFFIX_LENGTH)}</span>
                      </span>
                    </PairingDetail>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">
                      ID {accountId}
                    </Badge>
                  )}
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
              {resolvedBy ? (
                <PairingDetail
                  label={t(`pairing.${status}`)}
                  detail={t("pairing.resolved", {
                    actor: resolvedBy,
                    time: resolvedAt ? new Date(resolvedAt).toLocaleString(locale) : "",
                  })}
                >
                  {status === "approved" && <Check className="size-3.5" aria-hidden="true" />}
                  {t(`pairing.${status}`)}
                </PairingDetail>
              ) : (
                <Badge variant="outline" className="shrink-0 gap-1">
                  {status === "approved" && <Check className="size-3.5" aria-hidden="true" />}
                  {t(`pairing.${status}`)}
                </Badge>
              )}
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
    </TooltipProvider>
  );
}

export type PairingCodeState =
  | { kind: "ready"; code: string; copied: boolean; error?: boolean }
  | { kind: "loading" | "error" | "locked" };

export interface PairingCodeSectionProps {
  channel: string;
  accountName: string;
  state: PairingCodeState;
  onCopy: () => void;
  onRetry: () => void;
}

export function PairingCodeSection({
  channel,
  accountName,
  state,
  onCopy,
  onRetry,
}: PairingCodeSectionProps) {
  const { t } = useTranslation("activity");
  return (
    <details className="group">
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
