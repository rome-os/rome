import { useState, type ReactNode } from "react";
import type {
  TraceAccounting,
  TraceBlockDto,
  ToolResultBlock,
  ToolUseBlock,
} from "../../trace/types.js";
import { normalizeTracePayload } from "../vendor/rome-core/trace-format.js";
import { ThinkingBlock } from "../vendor/rome-core/ThinkingBlock.js";
import { TraceJsonView } from "../vendor/rome-core/TraceJsonView.js";
import { Markdown } from "../components/Markdown.js";
import { stripThreadContext } from "./derive.js";

// App-owned static block renderers injected into the vendored trace components
// (TraceBody / TraceRunRow) exactly as the chat page injects its own. This
// covers only the static block subset a frozen showcase contains — no live
// interactive cards. See web/vendor/VENDOR.md.

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds - minutes * 60);
  return `${minutes}m ${remainder}s`;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "0";
  return Math.round(value).toLocaleString();
}

function formatUsd(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return `$${value.toFixed(4)}`;
}

function formatPayload(value: unknown): string {
  const normalized = normalizeTracePayload(value);
  if (typeof normalized === "string") return normalized;
  try {
    return JSON.stringify(normalized, null, 2);
  } catch {
    return String(normalized);
  }
}

function unwrapTextContent(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.content) && record.content.length === 1) {
      const first = record.content[0];
      if (first && typeof first === "object" && "text" in first) {
        return (first as { text?: unknown }).text;
      }
    }
  }
  return value;
}

function previewPayload(value: unknown): string {
  const normalized = unwrapTextContent(normalizeTracePayload(value));
  if (normalized === null || normalized === undefined) return "";
  if (typeof normalized !== "object") return String(normalized).slice(0, 120);
  const record = normalized as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return "{}";
  const preview = keys
    .slice(0, 3)
    .map((key) => `${key}: ${shortValue(record[key])}`)
    .join(", ");
  return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
}

function shortValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object") return "{…}";
  return String(value);
}

function toolFailed(result: ToolResultBlock): boolean {
  if (result.isError !== undefined) return result.isError;
  return isLegacyErrorOutput(result.output);
}

// A result without `tool_result.isError` (recorded before the flag existed, or
// from a producer that cannot tell) falls back to each provider's own failure
// signal in the output.
function isLegacyErrorOutput(output: unknown): boolean {
  const normalized = normalizeTracePayload(output);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return false;
  const record = normalized as Record<string, unknown>;
  if (record.isError === true || record.is_error === true) return true;
  const status = record.status;
  if (typeof status === "string" && ["failed", "error", "errored"].includes(status.toLowerCase()))
    return true;
  const exitCode = record.exit_code ?? record.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0) return true;
  return hasErrorPayload(record.error) || hasErrorPayload(record.errors);
}

function hasErrorPayload(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function stepDurationMs(use: ToolUseBlock, result: ToolResultBlock | null): number | undefined {
  if (!result || !use.startedAt || !result.endedAt) return undefined;
  const start = Date.parse(use.startedAt);
  const end = Date.parse(result.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const delta = end - start;
  return delta >= 0 ? delta : undefined;
}

function Payload({
  label,
  value,
  plainLabel = false,
}: {
  label: string;
  value: unknown;
  /** Render the label as written (no uppercasing), e.g. "User prompt". */
  plainLabel?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div
        className={`text-aux font-semibold text-subtle-foreground${
          plainLabel ? "" : " uppercase tracking-wide"
        }`}
      >
        {label}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-8 border border-border bg-background p-2 font-mono text-xs leading-relaxed text-foreground">
        {formatPayload(value)}
      </pre>
    </div>
  );
}

function ToolStep({ use, result }: { use: ToolUseBlock; result: ToolResultBlock | null }) {
  const [open, setOpen] = useState(false);
  const status = result ? (toolFailed(result) ? "error" : "ok") : "running";
  const duration = formatDuration(stepDurationMs(use, result));
  const dotClass =
    status === "ok" ? "bg-success" : status === "error" ? "bg-destructive" : "bg-warning";
  return (
    <div className="border-l border-border pl-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-8 px-2 py-1.5 text-left hover:bg-surface-muted"
      >
        <span className="text-subtle-foreground">{open ? "⌄" : "›"}</span>
        <span className={`inline-block h-2 w-2 flex-none rounded-full ${dotClass}`} />
        <span className="flex-none font-medium text-foreground">{use.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-aux text-muted-foreground">
          {previewPayload(use.input)}
        </span>
        {duration && (
          <span className="flex-none font-mono text-aux text-subtle-foreground">{duration}</span>
        )}
      </button>
      {open && (
        <div className="ml-4 mb-1 flex flex-col gap-2.5">
          <DetailSection label="input" hint={use.tool}>
            <TraceJsonView value={use.input} />
          </DetailSection>
          {result ? (
            <DetailSection label="output" hint={describeOutputShape(result.output)}>
              <TraceJsonView value={result.output} />
            </DetailSection>
          ) : (
            <div className="text-xs text-subtle-foreground">No result captured.</div>
          )}
        </div>
      )}
    </div>
  );
}

// Tool input/output detail, mirroring the chat page's ToolStepBlock: a small
// label + hint header over the structured JSON view, each in its own framed box.
function DetailSection({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <header className="flex items-center justify-between px-0.5">
        <span className="text-aux font-semibold text-subtle-foreground">{label}</span>
        {hint && <span className="font-mono text-aux text-subtle-foreground">{hint}</span>}
      </header>
      <div className="rounded-8 border border-border bg-surface px-2.5 py-2">{children}</div>
    </section>
  );
}

// The chat page's output hint: a one-word shape of the result payload.
function describeOutputShape(output: unknown): string | undefined {
  const normalized = normalizeTracePayload(output);
  if (normalized == null) return undefined;
  if (Array.isArray(normalized)) {
    return `${normalized.length} item${normalized.length === 1 ? "" : "s"}`;
  }
  if (typeof normalized === "object") {
    const keys = Object.keys(normalized as Record<string, unknown>).length;
    return `${keys} key${keys === 1 ? "" : "s"}`;
  }
  return undefined;
}

function UsageSummary({ accounting }: { accounting: TraceAccounting }) {
  const usage = accounting.usage;
  const context = accounting.context;
  const cost = formatUsd(accounting.costUsd);
  return (
    <div className="mt-2 max-w-xl rounded-12 border border-border bg-surface p-3">
      <h4 className="mb-1 text-sm font-semibold text-foreground">Usage</h4>
      <div className="mb-2 font-mono text-xs text-muted-foreground">
        {accounting.provider} / {accounting.model}
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        <UsageRow label="cache_read" value={formatNumber(usage.cacheReadTokens)} />
        <UsageRow label="cache_write" value={formatNumber(usage.cacheWriteTokens)} />
        <UsageRow label="input" value={formatNumber(usage.inputTokens)} />
        <UsageRow label="output" value={formatNumber(usage.outputTokens)} />
        {context && (
          <div className="col-span-2 flex justify-between gap-4">
            <dt className="font-mono text-muted-foreground">context</dt>
            <dd className="font-semibold text-foreground">
              {formatNumber(context.usedTokens)}
              {context.windowTokens ? ` / ${formatNumber(context.windowTokens)}` : ""}
            </dd>
          </div>
        )}
      </dl>
      {cost && (
        <div className="mt-3 flex justify-between border-t border-border pt-2 text-xs">
          <span className="text-muted-foreground">API cost</span>
          <strong className="text-foreground">{cost}</strong>
        </div>
      )}
    </div>
  );
}

function UsageRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="font-mono text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  );
}

export function renderInlineBlock(block: TraceBlockDto, key: string): ReactNode {
  switch (block.type) {
    case "session_init": {
      const userPrompt = block.userPrompt ? stripThreadContext(block.userPrompt) : "";
      return (
        <div key={key} className="space-y-2 rounded-8 border border-border bg-surface p-2.5">
          {userPrompt && <Payload label="User prompt" value={userPrompt} plainLabel />}
        </div>
      );
    }
    case "text":
      return (
        <div key={key} className="px-1 py-1 text-sm text-foreground">
          <Markdown content={block.content} />
        </div>
      );
    case "thinking":
      return <ThinkingBlock key={key} content={block.content} />;
    case "result":
      return block.accounting ? (
        <UsageSummary key={key} accounting={block.accounting} />
      ) : (
        <div key={key} className="px-1 py-1 text-sm text-foreground">
          <Markdown content={block.content} />
        </div>
      );
    case "error":
      return (
        <div
          key={key}
          className="space-y-2 rounded-8 border border-destructive-border bg-destructive-bg p-2.5 text-sm text-destructive-fg"
        >
          <strong>Error</strong>
          <div className="whitespace-pre-wrap">{block.error}</div>
          {block.accounting && <UsageSummary accounting={block.accounting} />}
        </div>
      );
    case "structured_output":
      return <Payload key={key} label="Structured output" value={block.payload} />;
    case "tool_result":
      return <Payload key={key} label={`${block.tool} output`} value={block.output} />;
    case "tool_use":
      return <ToolStep key={key} use={block} result={null} />;
    default:
      return null;
  }
}

export function renderRunBlocks(blocks: TraceBlockDto[], _live: boolean): ReactNode {
  const resultsByUseId = new Map<string, ToolResultBlock>();
  const resultsByTool = new Map<string, ToolResultBlock[]>();
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    if (block.toolUseId) resultsByUseId.set(block.toolUseId, block);
    const bucket = resultsByTool.get(block.tool);
    if (bucket) bucket.push(block);
    else resultsByTool.set(block.tool, [block]);
  }

  const consumed = new Set<ToolResultBlock>();
  const nodes: ReactNode[] = [];
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      const paired = pickResult(block, resultsByUseId, resultsByTool, consumed);
      if (paired) consumed.add(paired);
      nodes.push(<ToolStep key={index} use={block} result={paired} />);
      return;
    }
    if (block.type === "tool_result" && consumed.has(block)) return;
    nodes.push(renderInlineBlock(block, String(index)));
  });
  return nodes;
}

function pickResult(
  use: ToolUseBlock,
  byId: Map<string, ToolResultBlock>,
  byTool: Map<string, ToolResultBlock[]>,
  consumed: Set<ToolResultBlock>,
): ToolResultBlock | null {
  if (use.id) {
    const candidate = byId.get(use.id);
    if (candidate && !consumed.has(candidate)) return candidate;
  }
  const bucket = byTool.get(use.tool);
  if (!bucket) return null;
  for (const candidate of bucket) {
    if (!consumed.has(candidate)) return candidate;
  }
  return null;
}
