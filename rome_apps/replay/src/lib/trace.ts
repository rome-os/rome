import type { AgentMessage, AgentPlan } from "@rome-os/app-runtime";

/**
 * Trace parsing, validation, summary, and the inverse of the server's
 * `toTraceBlock`: turning a recorded `TraceBlockDto`
 * back into an `AgentMessage` the replay turn-middleware can re-emit.
 *
 * App code may not import `@rome/api-types`, so the block shapes are mirrored
 * here as local types. They must stay structurally compatible with
 * `packages/api-types/src/trace-segments.ts` — the file this is the inverse of.
 */

/** Block types a trace.json may contain (mirror of `TraceBlockDto`). */
export const ALLOWED_BLOCK_TYPES = [
  "text",
  "thinking",
  "tool_use",
  "tool_result",
  "subagent_start",
  "subagent_result",
  "result",
  "error",
  "structured_output",
  "plan_update",
  "session_init",
  "turn_start",
  "turn_end",
] as const;

export type TraceBlockType = (typeof ALLOWED_BLOCK_TYPES)[number];

/** Loose mirror of `TraceBlockDto` — every block has a `type`; the rest are
 *  read defensively (a trace is user-supplied data, never trusted shape). */
export interface TraceBlock {
  type: TraceBlockType;
  [key: string]: unknown;
}

const ALLOWED_SET = new Set<string>(ALLOWED_BLOCK_TYPES);

/** Parsed-and-validated trace: the ordered block array plus its raw text. */
export interface ParsedTrace {
  blocks: TraceBlock[];
  /** The exact text that was parsed — re-stored verbatim for byte-faithful export. */
  raw: string;
}

/** A clear, surfaceable reason a trace.json was rejected. */
export class TraceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceParseError";
  }
}

/**
 * Parse the raw text of a downloaded trace.json and assert it is a well-formed
 * `TraceBlockDto[]`. Throws `TraceParseError` with a guardian-readable message
 * on any problem (not JSON / not an array / a block missing or with an unknown
 * `type`). Order is preserved exactly.
 */
export function parseTrace(raw: string): ParsedTrace {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new TraceParseError("Not valid JSON.");
  }
  if (!Array.isArray(value)) {
    throw new TraceParseError("Expected a JSON array of trace blocks.");
  }
  const blocks: TraceBlock[] = value.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new TraceParseError(`Block ${i} is not an object.`);
    }
    const type = (entry as { type?: unknown }).type;
    if (typeof type !== "string" || !ALLOWED_SET.has(type)) {
      throw new TraceParseError(`Block ${i} has an unknown type ${JSON.stringify(type)}.`);
    }
    return entry as TraceBlock;
  });
  return { blocks, raw };
}

export interface TraceSummary {
  /** Recorded user prompt: turn_start.userPrompt, else first session_init.userPrompt. */
  originalUserPrompt: string | null;
  /** turn_end.status. */
  status: string | null;
  /** result/error accounting.model. */
  model: string | null;
  /** turn_end.durationMs, falling back to accounting.durationMs. */
  durationMs: number | null;
  blockCount: number;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function accountingModel(block: TraceBlock): string | null {
  const acc = block.accounting;
  return acc && typeof acc === "object" ? str((acc as { model?: unknown }).model) : null;
}

function accountingDuration(block: TraceBlock): number | null {
  const acc = block.accounting;
  return acc && typeof acc === "object" ? num((acc as { durationMs?: unknown }).durationMs) : null;
}

/** Validate the provider-neutral Plan snapshot before replaying user-supplied trace data. */
function agentPlan(value: unknown): AgentPlan | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { explanation?: unknown; steps?: unknown };
  if (!Array.isArray(raw.steps)) return null;

  const steps: AgentPlan["steps"] = [];
  for (const entry of raw.steps) {
    if (!entry || typeof entry !== "object") return null;
    const step = entry as {
      id?: unknown;
      text?: unknown;
      activeText?: unknown;
      status?: unknown;
    };
    if (typeof step.text !== "string") return null;
    if (step.status !== "pending" && step.status !== "in_progress" && step.status !== "completed") {
      return null;
    }
    steps.push({
      ...(typeof step.id === "string" ? { id: step.id } : {}),
      text: step.text,
      ...(typeof step.activeText === "string" ? { activeText: step.activeText } : {}),
      status: step.status,
    });
  }

  return {
    ...(typeof raw.explanation === "string" ? { explanation: raw.explanation } : {}),
    steps,
  };
}

/** Extract the list-UI summary fields from a parsed trace's blocks. */
export function summarizeTrace(blocks: TraceBlock[]): TraceSummary {
  const summary: TraceSummary = {
    originalUserPrompt: null,
    status: null,
    model: null,
    durationMs: null,
    blockCount: blocks.length,
  };
  let sessionInitPrompt: string | null = null;
  // Tracked separately because the turn_end duration is authoritative but may
  // appear in the array after the result block it should override.
  let turnEndDuration: number | null = null;
  let accountingDuration_: number | null = null;
  for (const block of blocks) {
    switch (block.type) {
      case "turn_start":
        summary.originalUserPrompt ??= str(block.userPrompt);
        break;
      case "session_init":
        sessionInitPrompt ??= str(block.userPrompt);
        break;
      case "turn_end":
        summary.status ??= str(block.status);
        turnEndDuration ??= num(block.durationMs);
        break;
      case "result":
      case "error":
        summary.model ??= accountingModel(block);
        accountingDuration_ ??= accountingDuration(block);
        break;
      default:
        break;
    }
  }
  summary.originalUserPrompt ??= sessionInitPrompt;
  summary.durationMs = turnEndDuration ?? accountingDuration_;
  return summary;
}

/**
 * Inverse of the server's `toTraceBlock`: map a recorded block back
 * into the `AgentMessage` a turn-middleware re-emits. Lifecycle blocks
 * (`session_init` / `turn_start` / `turn_end`) return `null` — they are owned
 * by the AgentSession wrapper and a middleware must not emit them.
 *
 * `tool_use` / `tool_result` ids are synthesized when absent so the SDK's
 * required-id contract holds; real traces carry the original ids, which are
 * preserved verbatim so the pairing survives.
 */
export function blockToAgentMessage(block: TraceBlock, index: number): AgentMessage | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        content: typeof block.content === "string" ? block.content : "",
        ...(block.turnPhase === "commentary" || block.turnPhase === "final"
          ? { turnPhase: block.turnPhase }
          : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        content: typeof block.content === "string" ? block.content : "",
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: str(block.id) ?? `replay-tu-${index}`,
        tool: typeof block.tool === "string" ? block.tool : "unknown",
        input: block.input,
        ...(str(block.startedAt) ? { startedAt: block.startedAt as string } : {}),
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: str(block.toolUseId) ?? `replay-tu-${index}`,
        tool: typeof block.tool === "string" ? block.tool : "unknown",
        output: block.output,
        ...(str(block.endedAt) ? { endedAt: block.endedAt as string } : {}),
      };
    // A replay cannot safely recreate the recorded child session: uploaded
    // traces may come from another Rome instance, so their session/turn ids are
    // not valid links here. Preserve the visible invocation as an ordinary tool
    // pair instead, matching Replay's documented flattened-subagent behavior.
    case "subagent_start": {
      const toolUseId = str(block.toolUseId);
      const agentName = str(block.agentName);
      if (!toolUseId || !agentName) return null;
      return {
        type: "tool_use",
        id: toolUseId,
        tool: agentName,
        input: block.input,
        ...(str(block.startedAt) ? { startedAt: block.startedAt as string } : {}),
      };
    }
    case "subagent_result": {
      const toolUseId = str(block.toolUseId);
      const agentName = str(block.agentName);
      if (!toolUseId || !agentName) return null;
      if (
        block.status !== "completed" &&
        block.status !== "failed" &&
        block.status !== "cancelled"
      ) {
        return null;
      }
      return {
        type: "tool_result",
        toolUseId,
        tool: agentName,
        output:
          block.status === "completed"
            ? block.output
            : { status: block.status, error: block.error },
        ...(str(block.endedAt) ? { endedAt: block.endedAt as string } : {}),
      };
    }
    case "structured_output":
      return { type: "structured_output", payload: block.payload };
    case "plan_update": {
      const plan = agentPlan(block.plan);
      return plan ? { type: "plan_update", plan } : null;
    }
    case "result":
      return {
        type: "result",
        content: typeof block.content === "string" ? block.content : "",
        ...(Object.prototype.hasOwnProperty.call(block, "structuredOutput")
          ? { structuredOutput: block.structuredOutput }
          : {}),
        ...(block.accounting ? { accounting: block.accounting as never } : {}),
      };
    case "error":
      return {
        type: "error",
        error: typeof block.error === "string" ? block.error : "Replayed error",
        ...(block.accounting ? { accounting: block.accounting as never } : {}),
      };
    case "session_init":
    case "turn_start":
    case "turn_end":
      return null;
    default:
      return null;
  }
}

/** True for the terminal blocks that finalize a turn. */
export function isTerminalBlock(block: TraceBlock): boolean {
  return block.type === "result" || block.type === "error";
}
