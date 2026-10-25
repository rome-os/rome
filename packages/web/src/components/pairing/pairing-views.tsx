import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger, PopoverArrow } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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

/** A pairing request Rome stored before it stopped asking senders to pair,
 *  shown as history. None can be resolved (docs/domains/people.md#stranger). */
export interface PairingRequestCardProps extends PairingAccount {
  createdAt: string;
  expiresAt: number;
  status: "approved" | "rejected" | "expired";
  resolvedBy?: string | null;
  resolvedAt?: string | null;
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
        </div>
      </section>
    </TooltipProvider>
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
