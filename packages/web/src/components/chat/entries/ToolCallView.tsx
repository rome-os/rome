import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRightIcon } from "@radix-ui/react-icons";
import { describeBashCall } from "@/lib/bash-call-label";
import { artifactLocalName } from "@/lib/artifact-name";
import { formatTracePrimitive, normalizeTracePayload } from "@/lib/trace-format";
import { TraceJsonView } from "./TraceJsonView";

export type ToolCallStatus = "ok" | "running" | "pending" | "error";

const DOT_CLASS: Record<ToolCallStatus, string> = {
  ok: "bg-success",
  running: "bg-warning",
  pending: "bg-border-strong",
  error: "bg-destructive",
};

export function toolCallDotClass(status: ToolCallStatus, live = false): string {
  if (status === "running" && live) return "animate-pulse bg-info";
  return DOT_CLASS[status];
}

export function ToolCallView({
  tool,
  input,
  output,
  status,
  durationMs,
  hasResult,
  live = false,
}: {
  tool: string;
  input: unknown;
  output: unknown;
  status: ToolCallStatus;
  durationMs?: number;
  hasResult: boolean;
  live?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const toolLabel = artifactLocalName(tool);
  const summary = describeToolSummary(tool, input, output, hasResult, t);
  const duration = formatStepDuration(durationMs);
  const resultUnknown = !hasResult && !live;

  return (
    <div
      data-open={open}
      className={`group rounded-8 transition-colors ${
        open ? "bg-surface-muted" : "hover:bg-surface-muted/70"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full select-text items-center gap-2 rounded-8 py-2 pr-3 pl-7 text-left"
      >
        <ChevronRightIcon
          className={`h-3 w-3 flex-none text-subtle-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span
          aria-hidden="true"
          className={`inline-block h-1.5 w-1.5 flex-none rounded-full ${toolCallDotClass(status, live)}`}
        />
        <span className="min-w-0 truncate font-mono text-aux text-foreground" title={tool}>
          {toolLabel}
        </span>
        {summary && (
          <span
            title={summary}
            className="min-w-0 flex-1 truncate font-mono text-aux text-muted-foreground"
          >
            {summary}
          </span>
        )}
        {!summary && <span className="flex-1" />}
        {resultUnknown && (
          <span className="flex-none text-aux text-muted-foreground">
            {t("blocks.resultUnknown")}
          </span>
        )}
        {duration && (
          <span className="flex-none font-mono text-aux tracking-wide tabular-nums text-subtle-foreground">
            {duration}
          </span>
        )}
      </button>
      {open && (
        <div className="pt-1 pr-3 pb-3 pl-9">
          <ToolCallDetails tool={toolLabel} input={input} output={output} hasResult={hasResult} />
          {resultUnknown && (
            <p className="mt-2 text-aux text-muted-foreground">{t("blocks.resultUnknownHint")}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallDetails({
  tool,
  input,
  output,
  hasResult,
}: {
  tool: string;
  input: unknown;
  output: unknown;
  hasResult: boolean;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex flex-col gap-2">
      <DetailSection label={t("blocks.input")} hint={tool}>
        <TraceJsonView value={input} />
      </DetailSection>
      {hasResult && (
        <DetailSection label={t("blocks.output")} hint={describeOutputShape(output, t)}>
          <TraceJsonView value={output} />
        </DetailSection>
      )}
    </div>
  );
}

function DetailSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between px-1">
        <span className="text-aux text-subtle-foreground">{label}</span>
        {hint && <span className="font-mono text-aux text-subtle-foreground">{hint}</span>}
      </header>
      <div className="rounded-8 border border-border bg-surface px-2 py-2">{children}</div>
    </section>
  );
}

export function formatStepDuration(ms?: number): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainder}s`;
}

export function describeToolSummary(
  tool: string | undefined,
  input: unknown,
  output: unknown,
  hasResult: boolean,
  _t: (key: string) => string,
): string | null {
  if (tool === "Bash") {
    const phase = hasResult ? "completed" : "inProgress";
    const action = describeBashCall(input ?? output, phase);
    if (action) return action;
  }
  // WebSearch's query lives in the input for Claude Code but only in the
  // output for Codex (input is just `{ query: "" }`), so look for a non-empty
  // `query` in either payload before falling back to the generic summary.
  if (tool === "WebSearch" || tool === "web_search") {
    const query = findQueryField(input) ?? findQueryField(output);
    if (query) return query;
    return null;
  }
  return inputSummary(input) ?? primitivePreview(output) ?? null;
}

function findQueryField(value: unknown): string | null {
  const normalized = normalizeTracePayload(value);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return null;
  const q = (normalized as Record<string, unknown>).query;
  if (typeof q !== "string") return null;
  const trimmed = q.trim();
  return trimmed.length > 0 ? collapse(trimmed) : null;
}

function inputSummary(input: unknown): string | null {
  const normalized = normalizeTracePayload(input);
  if (normalized == null) return null;
  if (typeof normalized === "string") return collapse(normalized);
  if (typeof normalized !== "object") return formatTracePrimitive(normalized);

  // Prefer a single human-friendly field if present.
  if (!Array.isArray(normalized)) {
    const record = normalized as Record<string, unknown>;
    for (const key of ["query", "q", "command", "path", "url", "name", "prompt", "title"]) {
      const v = record[key];
      if (typeof v === "string" && v.trim().length > 0) return collapse(v);
    }
    const entries = Object.entries(record);
    if (entries.length === 0) return null;
    return entries
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${shortPrimitive(v)}`)
      .join(", ");
  }

  if (normalized.length === 0) return null;
  return normalized
    .slice(0, 3)
    .map((v) => shortPrimitive(v))
    .join(", ");
}

function primitivePreview(value: unknown): string | null {
  const normalized = normalizeTracePayload(value);
  if (normalized == null) return null;
  if (typeof normalized === "string") return collapse(normalized);
  if (typeof normalized !== "object") return formatTracePrimitive(normalized);
  return null;
}

function shortPrimitive(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return collapse(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === "object") return `{${Object.keys(value as object).length}}`;
  return formatTracePrimitive(value);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function describeOutputShape(
  output: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | undefined {
  const normalized = normalizeTracePayload(output);
  if (normalized == null) return undefined;
  if (Array.isArray(normalized)) {
    return t("blocks.itemCount", { count: normalized.length });
  }
  if (typeof normalized === "object") {
    const keys = Object.keys(normalized as Record<string, unknown>).length;
    return t("blocks.keyCount", { count: keys });
  }
  return undefined;
}
