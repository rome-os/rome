import { useTranslation } from "react-i18next";
import { Gauge } from "lucide-react";
import { Link } from "react-router-dom";
import { claudeUsesApiKey, type UsageWindowStatus } from "@rome/api-types/ai-tools";
import { useAiToolStatus } from "@/hooks/use-ai-tool-status";
import { UsageUpdatedAt } from "@/components/usage-updated-at";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CHAT_POPOVER_FIT } from "@/components/chat/chat-overlay";
import { usageProvider } from "./usage-provider";

export function formatUsageReset(
  resetsAt: string | undefined,
  locale: string,
  now = Date.now(),
): string | null {
  const reset = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(reset)) return null;
  return new Intl.DateTimeFormat(
    locale,
    Math.abs(reset - now) < 24 * 60 * 60 * 1000
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(reset);
}

export function UsageMenu({
  enabled,
  selection,
  pinnedModel,
  disabled = false,
}: {
  enabled: boolean;
  selection: string;
  pinnedModel?: string | null;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation("settings");
  const { data } = useAiToolStatus({ enabled });
  if (!enabled || !data) return null;
  const provider = usageProvider(selection, pinnedModel, data);
  const status =
    provider === "openai" ? data.codex : provider === "anthropic" ? data.claude : undefined;
  const usage = status?.usage;
  if (
    !status?.loggedIn ||
    claudeUsesApiKey(status) ||
    status.accountType === "api_key" ||
    !usage ||
    (!usage.error && !usage.fiveHour && !usage.sevenDay)
  )
    return null;
  const row = (label: string, window: UsageWindowStatus | undefined) => {
    if (!window) return null;
    const remaining =
      window.usedPercent === undefined ? window.remainingPercent : 100 - window.usedPercent;
    const reset = formatUsageReset(window.resetsAt, i18n.language);
    return (
      <div className="grid grid-cols-[1fr_auto_auto] items-baseline gap-4 text-ui">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">
          {remaining === undefined ? t("aiTools.usage.unavailable") : `${Math.round(remaining)}%`}
        </span>
        <span className="min-w-16 text-end text-muted-foreground tabular-nums">{reset}</span>
      </div>
    );
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="touch-target shrink-0"
          aria-label={t("aiTools.usage.remaining")}
          title={t("aiTools.usage.remaining")}
          disabled={disabled}
        >
          <Gauge aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        collisionPadding={CHAT_POPOVER_FIT.collisionPadding}
        aria-label={t("aiTools.usage.remaining")}
        className={`w-72 p-4 ${CHAT_POPOVER_FIT.className}`}
      >
        <h3 className="text-ui font-medium">{t("aiTools.usage.remaining")}</h3>
        {usage.error ? (
          <p role="status" className="text-ui text-muted-foreground">
            {t("aiTools.usage.unavailable")}
          </p>
        ) : (
          <div className="space-y-2">
            {row(t("aiTools.usage.shortFiveHour"), usage.fiveHour)}
            {row(t("aiTools.usage.weekly"), usage.sevenDay)}
          </div>
        )}
        <UsageUpdatedAt checkedAt={usage.checkedAt} />
        <Link to="/settings/ai-tools" className="block text-ui text-primary hover:underline">
          {t("aiTools.usage.manage")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
