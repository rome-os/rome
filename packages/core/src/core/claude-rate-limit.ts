import { z } from "zod";
import type { AIToolUsageStatus } from "../lib/provider-usage.js";

/** Marks usage read from a Claude turn, as opposed to the OAuth probe. */
export const CLAUDE_RATE_LIMIT_SOURCE = "claude rate limit event";

const windowSchema = z.object({
  // Past a limit the CLI can report more than 1, which is still a full window.
  utilization: z
    .number()
    .finite()
    .min(0)
    .transform((value) => Math.min(value, 1)),
  resetsAt: z
    .number()
    .finite()
    .positive()
    .refine((value) => Number.isFinite(new Date(value * 1000).getTime())),
});
const eventSchema = z.object({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.object({
    unifiedWindows: z.object({
      five_hour: windowSchema,
      seven_day: windowSchema,
    }),
  }),
});

/**
 * Reads the SDK's undocumented windows. An event takes effect only with both
 * windows, because a live update replaces the whole usage snapshot and must
 * not drop a known limit. Anything else leaves the OAuth fallback in charge.
 */
export function claudeRateLimitUsage(event: unknown): AIToolUsageStatus | null {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return null;
  const windows = parsed.data.rate_limit_info.unifiedWindows;
  const convert = (window: z.infer<typeof windowSchema>) => ({
    usedPercent: Math.round(window.utilization * 1000) / 10,
    remainingPercent: 100 - Math.round(window.utilization * 1000) / 10,
    resetsAt: new Date(window.resetsAt * 1000).toISOString(),
  });
  return {
    checkedAt: new Date().toISOString(),
    source: CLAUDE_RATE_LIMIT_SOURCE,
    fiveHour: convert(windows.five_hour),
    sevenDay: convert(windows.seven_day),
  };
}
