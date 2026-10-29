import { z } from "zod";
import type { AIToolUsageStatus } from "../lib/provider-usage.js";

const windowSchema = z.object({
  utilization: z.number().finite().min(0).max(1),
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
      five_hour: windowSchema.optional(),
      seven_day: windowSchema.optional(),
    }),
  }),
});

/** Undocumented SDK windows are optional. Invalid events leave the OAuth fallback intact. */
export function claudeRateLimitUsage(event: unknown): AIToolUsageStatus | null {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return null;
  const windows = parsed.data.rate_limit_info.unifiedWindows;
  if (!windows.five_hour && !windows.seven_day) return null;
  const convert = (window: z.infer<typeof windowSchema>) => ({
    usedPercent: Math.round(window.utilization * 1000) / 10,
    remainingPercent: 100 - Math.round(window.utilization * 1000) / 10,
    resetsAt: new Date(window.resetsAt * 1000).toISOString(),
  });
  return {
    checkedAt: new Date().toISOString(),
    source: "claude rate limit event",
    ...(windows.five_hour ? { fiveHour: convert(windows.five_hour) } : {}),
    ...(windows.seven_day ? { sevenDay: convert(windows.seven_day) } : {}),
  };
}
