import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ChevronDown, Gauge } from "lucide-react";
import {
  claudeUsesApiKey,
  type AIToolStatus,
  type UsageWindowStatus,
} from "@rome/api-types/ai-tools";
import { ModelProviderIcon } from "@/components/brand-icons/ai-tool-icons";
import { useAiToolStatus } from "@/hooks/use-ai-tool-status";
import { useSettings } from "@/hooks/use-settings";
import { UsageUpdatedAt } from "@/components/usage-updated-at";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

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

/** A tool shows usage when it is signed in on a subscription that reports windows. */
function showsUsage(status: AIToolStatus | undefined): status is AIToolStatus & {
  usage: NonNullable<AIToolStatus["usage"]>;
} {
  const usage = status?.usage;
  return (
    status?.loggedIn === true &&
    !claudeUsesApiKey(status) &&
    status.accountType !== "api_key" &&
    !!usage &&
    (!!usage.error || !!usage.fiveHour || !!usage.sevenDay)
  );
}

/**
 * The usage section of the account menu: remaining 5-hour and weekly share
 * for each signed-in subscription tool. It reads the shared status cache and
 * never asks a provider. The menu mounts it on open, so a reset that passed
 * while the menu was closed shows as reset.
 */
export function ProfileUsage() {
  const { t, i18n } = useTranslation("settings");
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(true);
  const { data: settings } = useSettings();
  const enabled = settings !== undefined && settings.showAiToolUsage !== false;
  const { data } = useAiToolStatus({ enabled });
  const tools = [
    { name: "ChatGPT", provider: "openai", status: data?.codex },
    { name: "Claude", provider: "anthropic", status: data?.claude },
  ].filter((tool) => showsUsage(tool.status)) as {
    name: string;
    provider: string;
    status: AIToolStatus & { usage: NonNullable<AIToolStatus["usage"]> };
  }[];
  if (!enabled || tools.length === 0) return null;

  const now = Date.now();
  const row = (label: string, window: UsageWindowStatus | undefined) => {
    if (!window) return null;
    // A window whose reset has passed is fresh again, though no reading since
    // says how much of it is used, so it reads "Reset" rather than old numbers.
    const resetPassed = Date.parse(window.resetsAt ?? "") <= now;
    const remaining =
      window.usedPercent === undefined ? window.remainingPercent : 100 - window.usedPercent;
    return (
      <div className="col-span-3 grid grid-cols-subgrid items-baseline py-1">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {resetPassed
            ? t("aiTools.usage.windowReset")
            : remaining === undefined
              ? t("aiTools.usage.unavailable")
              : `${Math.round(remaining)}%`}
        </span>
        <span className="text-end text-muted-foreground tabular-nums">
          {resetPassed ? null : formatUsageReset(window.resetsAt, i18n.language, now)}
        </span>
      </div>
    );
  };
  const oldestCheck = tools
    .map((tool) => tool.status.usage.checkedAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

  return (
    <>
      <DropdownMenuItem
        aria-expanded={expanded}
        onSelect={(event) => {
          // Toggling the section keeps the menu open.
          event.preventDefault();
          setExpanded((open) => !open);
        }}
      >
        <Gauge aria-hidden />
        {t("aiTools.usage.remaining")}
        <ChevronDown
          aria-hidden
          className={cn("ms-auto transition-transform", !expanded && "-rotate-90")}
        />
      </DropdownMenuItem>
      {expanded ? (
        <>
          {tools.map((tool) => (
            <div key={tool.name} role="group" aria-label={tool.name}>
              {/* The tool's mark sits in the menu's icon column, its name with the item text. */}
              <DropdownMenuLabel className="flex items-center gap-2 pt-2">
                <ModelProviderIcon provider={tool.provider} />
                {tool.name}
              </DropdownMenuLabel>
              {tool.status.usage.error ? (
                <p className="py-1 pr-2 pl-8 text-ui text-muted-foreground">
                  {t("aiTools.usage.unavailable")}
                </p>
              ) : (
                // One grid for the tool's rows keeps their columns aligned.
                <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 pr-2 pl-8 text-ui">
                  {row(t("aiTools.usage.shortFiveHour"), tool.status.usage.fiveHour)}
                  {row(t("aiTools.usage.weekly"), tool.status.usage.sevenDay)}
                </div>
              )}
            </div>
          ))}
          <UsageUpdatedAt checkedAt={oldestCheck} className="py-1 pr-2 pl-8" />
          <DropdownMenuItem inset onSelect={() => navigate("/settings/ai-tools")}>
            {t("aiTools.usage.manage")}
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuSeparator />
    </>
  );
}
