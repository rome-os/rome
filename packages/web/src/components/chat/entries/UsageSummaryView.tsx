import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import type {
  TraceAccounting,
  TraceModelUsage,
  TraceTokenUsage,
} from "@rome/api-types/trace-segments";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import { formatTraceNumber, formatUsd } from "./TracePayload";

export interface TraceUsageOptions {
  enabled: boolean;
  includeSubagentUsage: boolean;
  loading: boolean;
  onIncludeSubagentUsageChange: (include: boolean) => void;
}

export const TraceUsageOptionsContext = createContext<TraceUsageOptions | null>(null);

function totalTokens(usage: TraceTokenUsage): number {
  return usage.cacheReadTokens + usage.cacheWriteTokens + usage.inputTokens + usage.outputTokens;
}

function fallbackModelUsage(accounting: TraceAccounting): TraceModelUsage {
  return {
    provider: accounting.provider,
    model: accounting.model,
    usage: accounting.usage,
    costUsd: accounting.costUsd,
    runCount: 1,
  };
}

function UsageStat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    // Sans and mono baselines differ at 13px, so this mixed-font row needs an explicit cross-size.
    <div className="flex h-4 min-w-0 items-baseline justify-between gap-3">
      {hint ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              tabIndex={0}
              className="truncate text-aux text-muted-foreground underline decoration-dotted underline-offset-2 outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
            >
              {label}
            </span>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{hint}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="truncate text-aux text-muted-foreground">{label}</span>
      )}
      <span className="font-mono text-aux text-foreground tabular-nums">
        {formatTraceNumber(value)}
      </span>
    </div>
  );
}

export function UsageSummaryView({ accounting }: { accounting: TraceAccounting }) {
  const { t } = useTranslation("chat");
  const options = useContext(TraceUsageOptionsContext);
  const context = accounting.context;
  const formattedCost = formatUsd(accounting.costUsd) ?? t("usage.costUnknown");
  const aggregateTokens = totalTokens(accounting.usage);
  const models = accounting.usageByModel?.length
    ? accounting.usageByModel
    : [fallbackModelUsage(accounting)];
  const hasMultipleModels = models.length > 1;
  const contextPercent =
    context?.windowTokens && context.windowTokens > 0
      ? Math.min(100, Math.max(0, (context.usedTokens / context.windowTokens) * 100))
      : null;

  return (
    <div
      className="@container my-3 rounded-12 border border-border bg-surface-muted px-4 py-3 text-foreground"
      aria-busy={options?.loading || undefined}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="text-section text-foreground">{t("usage.title")}</div>
        {options?.enabled ? (
          <label className="flex cursor-pointer items-center gap-2 text-aux text-muted-foreground">
            <span>{t("usage.includeSubagents")}</span>
            <Switch
              size="sm"
              checked={options.includeSubagentUsage}
              disabled={options.loading}
              onCheckedChange={options.onIncludeSubagentUsageChange}
              aria-label={t("usage.includeSubagents")}
            />
          </label>
        ) : null}
      </div>

      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-aux text-muted-foreground">
        {hasMultipleModels ? (
          <span>{t("usage.modelCount", { count: models.length })}</span>
        ) : (
          <span className="font-mono">
            {accounting.provider} / {accounting.model}
          </span>
        )}
        {accounting.includedSubagentCount ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{t("usage.includedSubagents", { count: accounting.includedSubagentCount })}</span>
          </>
        ) : null}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-aux text-foreground">{t("usage.totalTokens")}</span>
          <span className="font-mono text-ui text-foreground tabular-nums">
            {formatTraceNumber(aggregateTokens)}
          </span>
        </div>
        {/* Two label-and-count pairs need about 18rem side by side, more than
            a phone-width trace drawer leaves, so narrow cards stack them. */}
        <div className="mt-2 grid grid-cols-1 gap-x-5 gap-y-2 @min-[18rem]:grid-cols-2">
          <UsageStat label={t("usage.labels.cacheRead")} value={accounting.usage.cacheReadTokens} />
          <UsageStat
            label={t("usage.labels.cacheWrite")}
            value={accounting.usage.cacheWriteTokens}
          />
          <UsageStat label={t("usage.labels.input")} value={accounting.usage.inputTokens} />
          <UsageStat label={t("usage.labels.output")} value={accounting.usage.outputTokens} />
          {accounting.usage.reasoningTokens !== undefined ? (
            <UsageStat
              label={t("usage.labels.reasoning")}
              value={accounting.usage.reasoningTokens}
              hint={t("usage.reasoningHint")}
            />
          ) : null}
        </div>
      </div>

      {hasMultipleModels ? (
        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-2 text-aux text-foreground">{t("usage.modelUsage")}</div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-2">
            <div className="text-aux text-subtle-foreground">{t("usage.model")}</div>
            <div className="text-right text-aux text-subtle-foreground">{t("usage.tokens")}</div>
            <div className="text-right text-aux text-subtle-foreground">{t("usage.cost")}</div>
            {models.map((entry) => {
              const isMain =
                entry.provider === accounting.provider && entry.model === accounting.model;
              return (
                <div key={`${entry.provider}:${entry.model}`} className="contents">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-aux text-foreground">
                      {entry.provider} / {entry.model}
                    </div>
                    <div className="text-aux text-subtle-foreground">
                      {isMain
                        ? t("usage.mainModel")
                        : entry.runCount > 1
                          ? t("usage.runCount", { count: entry.runCount })
                          : t("usage.subagentModel")}
                    </div>
                  </div>
                  <div className="self-start whitespace-nowrap text-right font-mono text-aux text-foreground tabular-nums">
                    {formatTraceNumber(totalTokens(entry.usage))}
                  </div>
                  <div className="self-start whitespace-nowrap text-right font-mono text-aux text-foreground tabular-nums">
                    {formatUsd(entry.costUsd) ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {context ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border pt-3">
          <span className="text-aux text-muted-foreground">
            {t(
              accounting.includedSubagentCount
                ? "usage.labels.mainContext"
                : "usage.labels.context",
            )}
          </span>
          {/* The count never breaks mid-number, so on a narrow card the ring
              and count wrap below the label instead. */}
          <span className="ml-auto flex items-center gap-2">
            {contextPercent !== null ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    tabIndex={0}
                    className="inline-flex shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <svg
                      role="progressbar"
                      aria-label={t("usage.contextUsage")}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(contextPercent)}
                      viewBox="0 0 28 28"
                      className="size-7"
                    >
                      <circle
                        cx="14"
                        cy="14"
                        r="11.5"
                        fill="none"
                        strokeWidth="3"
                        className="stroke-border-strong"
                      />
                      <circle
                        cx="14"
                        cy="14"
                        r="11.5"
                        fill="none"
                        strokeWidth="3"
                        strokeLinecap="round"
                        pathLength="100"
                        strokeDasharray="100"
                        strokeDashoffset={100 - contextPercent}
                        transform="rotate(-90 14 14)"
                        className="stroke-primary transition-[stroke-dashoffset] duration-300 ease-out"
                      />
                    </svg>
                  </span>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>
                  {t("usage.contextUsage")}: {Math.round(contextPercent)}%
                </TooltipContent>
              </Tooltip>
            ) : null}
            <span className="whitespace-nowrap font-mono text-aux text-foreground tabular-nums">
              {context.windowTokens
                ? `${formatTraceNumber(context.usedTokens)} / ${formatTraceNumber(context.windowTokens)}`
                : formatTraceNumber(context.usedTokens)}
            </span>
          </span>
        </div>
      ) : null}

      <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
        <span className="text-aux text-foreground">{t("usage.apiCostLabel")}</span>
        <span className="font-mono text-ui text-foreground tabular-nums">{formattedCost}</span>
      </div>
    </div>
  );
}
