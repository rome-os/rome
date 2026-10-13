// Shared parser for the locally-cached provider usage/rate-limit snapshots that
// the Claude / Codex CLIs write under `~/.{claude,codex}/{rate,usage}-limits.json`.
//
// Used by both the AI-Tools dashboard route and the codex→Claude quota fallback,
// so they read the SAME rich set of shapes (snake/camel case, provider-specific
// `utilization` units, reset timestamps, and free-text status lines) instead of
// each maintaining its own narrower parser that could miss a genuinely-exhausted
// window.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("provider-usage");

const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

export interface UsageWindowStatus {
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: string;
}

export interface AIToolUsageStatus {
  checkedAt: string;
  source: string;
  fiveHour?: UsageWindowStatus;
  sevenDay?: UsageWindowStatus;
  error?: string;
}

interface UsageNormalizationOptions {
  utilizationUnit?: "percent" | "fraction";
}

const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;
const SEVEN_DAY_WINDOW_MINUTES = 7 * 24 * 60;
const WINDOW_DURATION_KEYS = [
  "windowDurationMins",
  "window_duration_mins",
  "windowDurationMinutes",
  "window_duration_minutes",
];

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Command failed";
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function parsePercent(
  value: unknown,
  options: { scaleFraction?: boolean } = {},
): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampPercent(options.scaleFraction && value <= 1 ? value * 100 : value);
  }
  if (typeof value !== "string") return undefined;
  const match = value.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return undefined;
  const hasExplicitPercent = value.includes("%");
  return clampPercent(
    options.scaleFraction && !hasExplicitPercent && parsed <= 1 ? parsed * 100 : parsed,
  );
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function getRecordPercent(
  record: Record<string, unknown>,
  fields: Array<{ key: string; scaleFraction?: boolean }>,
): number | undefined {
  for (const field of fields) {
    if (record[field.key] === undefined) continue;
    const percent = parsePercent(record[field.key], { scaleFraction: field.scaleFraction });
    if (percent !== undefined) return percent;
  }
  return undefined;
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function usageWindowDurationMinutes(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = getRecordValue(value as Record<string, unknown>, WINDOW_DURATION_KEYS);
  const duration = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function normalizeUsageWindow(
  value: unknown,
  options: UsageNormalizationOptions,
): UsageWindowStatus | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usedPercent = getRecordPercent(record, [
    { key: "usedPercent" },
    { key: "used_percent" },
    { key: "usagePercent" },
    { key: "usage_percent" },
    { key: "utilization", scaleFraction: options.utilizationUnit === "fraction" },
    { key: "utilizationPercent" },
    { key: "utilization_percent" },
    { key: "percent" },
    { key: "percentage" },
  ]);
  const remainingPercent = getRecordPercent(record, [
    { key: "remainingPercent" },
    { key: "remaining_percent" },
    { key: "remaining" },
  ]);
  const resetsAt = parseTimestamp(
    getRecordValue(record, ["resetsAt", "resets_at", "resetAt", "reset_at", "reset"]),
  );

  if (usedPercent === undefined && remainingPercent === undefined && !resetsAt) {
    return undefined;
  }
  return {
    usedPercent:
      usedPercent ??
      (remainingPercent === undefined ? undefined : clampPercent(100 - remainingPercent)),
    remainingPercent:
      remainingPercent ?? (usedPercent === undefined ? undefined : clampPercent(100 - usedPercent)),
    resetsAt,
  };
}

function findUsageWindowWithoutDuration(
  record: Record<string, unknown>,
  keys: string[],
  options: UsageNormalizationOptions,
): UsageWindowStatus | undefined {
  for (const key of keys) {
    if (usageWindowDurationMinutes(record[key]) !== undefined) continue;
    const window = normalizeUsageWindow(record[key], options);
    if (window) return window;
  }
  return undefined;
}

function findUsageWindowByDuration(
  record: Record<string, unknown>,
  durationMinutes: number,
  options: UsageNormalizationOptions,
): UsageWindowStatus | undefined {
  for (const value of Object.values(record)) {
    if (usageWindowDurationMinutes(value) !== durationMinutes) continue;
    const window = normalizeUsageWindow(value, options);
    if (window) return window;
  }
  return undefined;
}

export function normalizeUsageStatus(
  value: unknown,
  source: string,
  options: UsageNormalizationOptions = {},
): AIToolUsageStatus | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.rate_limits ?? record.rateLimits ?? record.usage ?? record;
  if (!nested || typeof nested !== "object") return null;
  const usage = nested as Record<string, unknown>;
  const fiveHour =
    findUsageWindowByDuration(usage, FIVE_HOUR_WINDOW_MINUTES, options) ??
    findUsageWindowWithoutDuration(
      usage,
      ["fiveHour", "five_hour", "primary", "primaryWindow", "primary_window", "session"],
      options,
    );
  const sevenDay =
    findUsageWindowByDuration(usage, SEVEN_DAY_WINDOW_MINUTES, options) ??
    findUsageWindowWithoutDuration(
      usage,
      [
        "sevenDay",
        "seven_day",
        "secondary",
        "secondaryWindow",
        "secondary_window",
        "weekly",
        "week",
      ],
      options,
    );
  if (!fiveHour && !sevenDay) return null;
  return {
    checkedAt: new Date().toISOString(),
    source,
    fiveHour,
    sevenDay,
  };
}

export function parseUsageText(output: string, source: string): AIToolUsageStatus | null {
  const normalized = output.replace(/\s+/g, " ");
  const remainingMode = /remaining|left/i.test(normalized);
  function parseWindow(pattern: RegExp): UsageWindowStatus | undefined {
    const match = normalized.match(pattern);
    if (!match?.[1]) return undefined;
    const percent = parsePercent(match[1]);
    if (percent === undefined) return undefined;
    return remainingMode
      ? { usedPercent: clampPercent(100 - percent), remainingPercent: percent }
      : { usedPercent: percent, remainingPercent: clampPercent(100 - percent) };
  }
  const fiveHour = parseWindow(/(?:5h|5[-\s]?hour|five[-\s]?hour)[^0-9]{0,40}(\d+(?:\.\d+)?)\s*%/i);
  const sevenDay = parseWindow(
    /(?:7d|7[-\s]?day|seven[-\s]?day|weekly|week)[^0-9]{0,40}(\d+(?:\.\d+)?)\s*%/i,
  );
  if (!fiveHour && !sevenDay) return null;
  return {
    checkedAt: new Date().toISOString(),
    source,
    fiveHour,
    sevenDay,
  };
}

export async function readUsageCache(
  paths: string[],
  options: UsageNormalizationOptions = {},
): Promise<AIToolUsageStatus | null> {
  for (const path of paths) {
    try {
      const raw = await fs.readFile(path, "utf8");
      let parsed: AIToolUsageStatus | null = null;
      try {
        parsed = normalizeUsageStatus(JSON.parse(raw), path, options);
      } catch {
        parsed = null;
      }
      if (parsed) return parsed;
      const textParsed = parseUsageText(raw, path);
      if (textParsed) return textParsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") continue;
    }
  }
  return null;
}

export function hasUsageWindows(usage: AIToolUsageStatus): boolean {
  return usage.fiveHour !== undefined || usage.sevenDay !== undefined;
}

const CLAUDE_USAGE_WINDOW_KEYS = ["five_hour", "seven_day"];

// The OAuth usage endpoint types each window as nullable, so it can name a
// window without reporting it: `seven_day: null`, or `utilization: null` with
// no reset time. That is a successful answer with no usage to show. A payload
// with neither key is a shape this parser does not know.
function claudeReportsNoUsageWindows(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  const present = CLAUDE_USAGE_WINDOW_KEYS.filter((key) => key in record);
  return (
    present.length > 0 &&
    present.every((key) => {
      const window = record[key];
      if (window === null) return true;
      if (typeof window !== "object") return false;
      const { utilization, resets_at } = window as Record<string, unknown>;
      return utilization === null && (resets_at === null || resets_at === undefined);
    })
  );
}

/**
 * Live Claude usage via the OAuth `/api/oauth/usage` endpoint, using the token
 * from `CLAUDE_CODE_OAUTH_TOKEN` or `~/.claude/.credentials.json`. Returns null
 * when no token is available; otherwise a status (possibly carrying `error` on a
 * failed/timed-out request). A status with neither `error` nor a window means
 * the endpoint reported no usage windows. This is the only reliable Claude
 * usage source — nothing persists `~/.claude/{rate,usage}-limits.json` locally.
 */
export async function readClaudeOAuthUsage(
  timeoutMs: number = CLAUDE_USAGE_TIMEOUT_MS,
): Promise<AIToolUsageStatus | null> {
  let accessToken =
    typeof process.env.CLAUDE_CODE_OAUTH_TOKEN === "string"
      ? process.env.CLAUDE_CODE_OAUTH_TOKEN
      : undefined;
  if (!accessToken) {
    try {
      const raw = await fs.readFile(CLAUDE_CREDENTIALS_PATH, "utf8");
      const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
      if (typeof parsed.claudeAiOauth?.accessToken === "string") {
        accessToken = parsed.claudeAiOauth.accessToken;
      }
    } catch {
      return null;
    }
  }
  if (!accessToken) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const baseUrl = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(
      /\/+$/,
      "",
    );
    const res = await fetch(`${baseUrl}/api/oauth/usage`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "rome",
      },
    });
    if (!res.ok) {
      log.error("Claude usage request failed", {
        status: res.status,
        retryAfter: res.headers.get("retry-after") ?? undefined,
      });
      return {
        checkedAt: new Date().toISOString(),
        source: "claude oauth usage",
        error: `Claude usage request failed with HTTP ${res.status}`,
      };
    }
    const payload: unknown = await res.json();
    const usage = normalizeUsageStatus(payload, "claude oauth usage", {
      utilizationUnit: "percent",
    });
    if (usage) return usage;
    if (claudeReportsNoUsageWindows(payload)) {
      return { checkedAt: new Date().toISOString(), source: "claude oauth usage" };
    }
    return {
      checkedAt: new Date().toISOString(),
      source: "claude oauth usage",
      error: "Claude usage response did not include usage windows",
    };
  } catch (err) {
    return {
      checkedAt: new Date().toISOString(),
      source: "claude oauth usage",
      error: getErrorMessage(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function readLiveOrCachedUsage(
  liveProbe: () => Promise<AIToolUsageStatus | null>,
  cachePaths: string[],
  options: UsageNormalizationOptions = {},
): Promise<AIToolUsageStatus | null> {
  let liveUsage: AIToolUsageStatus | null = null;
  try {
    liveUsage = await liveProbe();
  } catch (err) {
    liveUsage = {
      checkedAt: new Date().toISOString(),
      source: "live usage probe",
      error: getErrorMessage(err),
    };
  }
  if (liveUsage && (!liveUsage.error || hasUsageWindows(liveUsage))) {
    return liveUsage;
  }
  return (await readUsageCache(cachePaths, options)) ?? liveUsage;
}
