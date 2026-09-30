// Translate a per-turn buffer of AgentMessage blocks into OpenTelemetry
// children of `model.turn`:
//   - one `tool` span per tool_use ↔ tool_result pair, matched by use_id
//   - `thinking` / `text` blocks recorded as point events on `model.turn`
//
// Why we don't emit a `model.round` span: a "round" (one LLM call within the
// agent loop) isn't a universally well-defined wall-clock window. The
// Anthropic SDK enforces a strict contract — every tool_use's result must
// land before the next assistant message — so rounds could be inferred from
// the block stream. The Codex SDK pipelines tool calls: a second LLM call
// can be issued before all prior tool_results have returned, so round
// windows overlap and can't be partitioned from the stream alone. Rather
// than ship inference that's right for one provider and broken for the
// other, we promote the universally true invariants instead: every
// tool_use in a turn has a matched tool_result before the terminal block,
// and the provider knows when each LLM call starts/ends (a future `llm.call`
// span emitted by the provider will fill the per-call-detail gap that
// `model.round` was trying to provide).
//
// The function is pure over its inputs (blocks + parent span); all OTel
// state is created and ended within one synchronous call.

import { trace, type Attributes, type Context, type Span } from "@opentelemetry/api";
import type { AgentMessage } from "../types.js";
import { getTracer } from "../telemetry.js";

export interface CapturedBlock {
  block: AgentMessage;
  /** Wall-clock ms when AgentSession yielded this block from modelSession.events. */
  tsMs: number;
}

export interface TranslateTurnSpansArgs {
  blocks: CapturedBlock[];
  /** The active `model.turn` span — tool spans + events parent under this. */
  modelSpan: Span;
  /** OTel context carrying the turn's agent span; used to scope child spans. */
  turnCtx: Context;
  /** Start time of `model.turn` — used as a floor when a tool_use lacks `startedAt`. */
  modelTurnStartMs: number;
  /** Wall-clock ms of the terminal block; used as a floor for unmatched tool_results. */
  terminalTsMs: number;
  /**
   * Identifying attrs (agent.name / session.id / turn.id / channel.*) that
   * every span this turn creates should carry. Passed explicitly so they
   * don't leak via OTel baggage; AgentSession owns the canonical bag.
   */
  romeAttrs: Attributes;
}

interface ToolUseRecord {
  tool: string;
  useId: string;
  startedAtMs: number;
}

/**
 * Walk `blocks`, emit `tool` spans under `modelSpan`, and record
 * `thinking` / `text` blocks as point events on `modelSpan`. Safe to call
 * once per turn at terminal time.
 *
 * Tool spans are matched by `tool_use.id` ↔ `tool_result.toolUseId`, so a
 * tool whose result arrives in a later batch (Codex pipelining) still
 * produces a correctly-bounded span. Unmatched tool_uses (turn ended
 * before the result landed — only seen on error/interrupt paths) get a
 * span whose end time is `terminalTsMs` with `tool.completed=false`.
 */
export function translateTurnSpans(args: TranslateTurnSpansArgs): void {
  const { blocks, modelSpan, turnCtx, modelTurnStartMs, terminalTsMs, romeAttrs } = args;

  const tracer = getTracer("rome");
  const modelSpanCtx = trace.setSpan(turnCtx, modelSpan);

  const toolUses = new Map<string, ToolUseRecord>();
  const toolResultsByUseId = new Map<string, { endedAtMs: number; isError: boolean }>();

  for (const { block, tsMs } of blocks) {
    switch (block.type) {
      case "thinking":
        modelSpan.addEvent("thinking", { "content.length": block.content.length }, tsMs);
        break;
      case "text":
        modelSpan.addEvent("text", { "content.length": block.content.length }, tsMs);
        break;
      case "tool_use": {
        const startedAtMs = parseIsoMs(block.startedAt) ?? Math.max(tsMs, modelTurnStartMs);
        toolUses.set(block.id, {
          tool: block.tool,
          useId: block.id,
          startedAtMs,
        });
        break;
      }
      case "tool_result": {
        const endedAtMs = parseIsoMs(block.endedAt) ?? tsMs;
        // The adapter's flag decides. Claude's `{ content, isError }` output
        // wrapper is the fallback for a producer that sets no flag.
        const isError =
          block.isError ?? (block.output as { isError?: unknown } | null)?.isError === true;
        toolResultsByUseId.set(block.toolUseId, { endedAtMs, isError });
        break;
      }
      default:
        // session_init, result, error, structured_output — not tool-shaped.
        break;
    }
  }

  for (const use of toolUses.values()) {
    const res = toolResultsByUseId.get(use.useId);
    const completedAttrs = res
      ? { "tool.is_error": res.isError, "tool.completed": true }
      : { "tool.completed": false };
    const toolSpan = tracer.startSpan(
      "tool",
      {
        attributes: {
          ...romeAttrs,
          provider: "claude_code",
          "tool.name": use.tool,
          "tool.use_id": use.useId,
          ...completedAttrs,
        },
        startTime: use.startedAtMs,
      },
      modelSpanCtx,
    );
    toolSpan.end(res?.endedAtMs ?? terminalTsMs);
  }
}

function parseIsoMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}
