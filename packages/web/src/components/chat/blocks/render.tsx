import type { ApprovalCardStatus, StreamBlock } from "@/lib/chat-types";
import { normalizeTracePayload } from "@/lib/trace-format";
import { interactionResultKey } from "@/components/chat/chat-view";
import { ApprovalCard } from "../approval/ApprovalCard";
import { AgentCallBlock } from "./AgentCallBlock";
import { AiToolsCard } from "./AiToolsCard";
import { AppComponentBlock } from "./AppComponentBlock";
import { ErrorRunBlock } from "./ErrorBlock";
import { HandoffCard } from "./HandoffCard";
import { QuestionCard } from "./QuestionCard";
import { RoutineDraftCard } from "./RoutineDraftCard";
import { SubagentStepBlock } from "./SubagentStepBlock";
import { TextBlock } from "./TextBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBlock } from "./ToolResultBlock";
import { ToolStepBlock, type ToolStepStatus } from "./ToolStepBlock";
import { ToolUseBlock } from "./ToolUseBlock";
import { TurnRecapBlock } from "./TurnRecapBlock";
import { UsageSummaryBlock } from "./UsageSummaryBlock";

export interface RenderBlockOptions {
  onApprovalResolved?: () => void;
  compact?: boolean;
  toolUseInput?: unknown;
  /** Trace drawer is currently live-streaming (forwarded to ToolStepBlock). */
  live?: boolean;
  /** Session that owns the message these blocks belong to — namespaces resolved
   * interaction state and routes submissions to the right session in the merged
   * (multi-session) transcript. */
  sessionId?: string;
  /** Map of `interactionResultKey(sessionId, toolUseId)` → submitted output. */
  interactionResults?: Map<string, Record<string, unknown>>;
  /** Invoked when an inline app component submits its result. */
  onSubmitAppComponent?: (
    sessionId: string,
    toolUseId: string,
    output: Record<string, unknown>,
    summary?: string,
  ) => void | Promise<void>;
  /** Invoked when an inline app component dismisses without a result. */
  onDismissAppComponent?: (sessionId: string, toolUseId: string) => void | Promise<void>;
}

export function renderSingleBlock(
  block: StreamBlock,
  key: string | number,
  options: RenderBlockOptions = {},
) {
  const {
    onApprovalResolved,
    compact = false,
    toolUseInput,
    sessionId,
    interactionResults,
    onSubmitAppComponent,
    onDismissAppComponent,
  } = options;
  // The blocks of one message all share its session; submissions/lookups use it.
  const sid = sessionId ?? "";
  const resultFor = (toolUseId: string) =>
    interactionResults?.get(interactionResultKey(sid, toolUseId));
  const submit = onSubmitAppComponent
    ? (toolUseId: string, output: Record<string, unknown>, summary?: string) =>
        onSubmitAppComponent(sid, toolUseId, output, summary)
    : () => {};
  const dismiss = onDismissAppComponent
    ? (toolUseId: string) => onDismissAppComponent(sid, toolUseId)
    : () => {};
  switch (block.type) {
    case "session_init":
      return (
        <AgentCallBlock
          key={key}
          agent={block.agent}
          sessionId={block.sessionId}
          romeSession={block.romeSession}
          systemPrompt={block.systemPrompt}
          userPrompt={block.userPrompt}
        />
      );
    case "thinking":
      return <ThinkingBlock key={key} content={block.content ?? ""} />;
    case "tool_use":
      return <ToolUseBlock key={key} tool={block.tool} input={block.input} />;
    case "tool_result":
      return (
        <ToolResultBlock key={key} tool={block.tool} output={block.output} input={toolUseInput} />
      );
    case "subagent_start":
      if (!block.agentName || !block.sessionId || !block.turnId) return null;
      return (
        <SubagentStepBlock
          key={key}
          agentName={block.agentName}
          input={block.input}
          sessionId={block.sessionId}
          turnId={block.turnId}
          status="running"
          live={options.live}
        />
      );
    case "subagent_result":
      if (!block.agentName || !block.sessionId || !block.turnId || !block.status) return null;
      return (
        <SubagentStepBlock
          key={key}
          agentName={block.agentName}
          sessionId={block.sessionId}
          turnId={block.turnId}
          status={block.status as "completed" | "failed" | "cancelled"}
          output={block.output}
          error={typeof block.error === "object" ? block.error : undefined}
        />
      );
    case "text":
      // In-turn narration: give each commentary its own gap so consecutive
      // narration reads as separate utterances under one speaker (not a run-on
      // paragraph). Same text styling as the final answer. The final answer
      // renders bare, as before.
      return block.turnPhase === "commentary" ? (
        <div key={key} className="mb-3">
          <TextBlock content={block.content ?? ""} compact={compact} />
        </div>
      ) : (
        <TextBlock key={key} content={block.content ?? ""} compact={compact} />
      );
    case "turn_recap":
      return (
        <TurnRecapBlock
          key={key}
          content={block.content ?? ""}
          audioUrl={block.audioUrl}
          audioMimeType={block.audioMimeType}
          audioDurationMs={block.audioDurationMs}
        />
      );
    case "routine_draft_card":
      if (!block.draft) return null;
      return <RoutineDraftCard key={`routine-${block.toolUseId ?? key}`} draft={block.draft} />;
    case "submission_card":
      // The borrowed agent's submit_output is not rendered in the conversation
      // flow — the result already lives on the app's own surface beside the
      // chat, and the approval gate is the composer's Approve button. The block
      // stays in the message stream only as the signal that a submission is
      // pending (read by findActiveSubmission to drive that button).
      return null;
    case "pending_interaction": {
      if (!block.toolUseId || !block.appId || !block.render) return null;
      // Host built-in components (the ask_question card, the connect_ai card):
      // rendered directly by rome-web, no app bundle to mount. They resolve
      // through the same interaction_result path as an app component.
      if (block.render.builtin && block.render.componentId === "ai-tools-card") {
        return (
          <AiToolsCard
            key={`ai-tools-card-${block.toolUseId}`}
            toolUseId={block.toolUseId}
            result={resultFor(block.toolUseId)}
            onSubmit={submit}
          />
        );
      }
      if (block.render.builtin && block.render.componentId === "question-card") {
        return (
          <QuestionCard
            key={`question-card-${block.toolUseId}`}
            toolUseId={block.toolUseId}
            props={block.render.props}
            result={resultFor(block.toolUseId)}
            onSubmit={submit}
            onDismiss={dismiss}
          />
        );
      }
      return (
        <AppComponentBlock
          key={`app-component-${block.toolUseId}`}
          toolUseId={block.toolUseId}
          appId={block.appId}
          componentId={block.render.componentId}
          props={block.render.props}
          result={resultFor(block.toolUseId)}
          onSubmit={submit}
          onDismiss={dismiss}
        />
      );
    }
    case "handoff": {
      // The @mention seam in the flat transcript; the specialist's turns render
      // inline as ordinary rows right below it (their child session is merged in
      // by Chat). The brief is shown here as the calling agent's mention.
      if (!block.toolUseId || !block.appId) return null;
      const agentLabel =
        typeof block.payload?.agentLabel === "string" ? block.payload.agentLabel : undefined;
      const summary =
        typeof block.payload?.summary === "string" ? block.payload.summary : undefined;
      // Open until its interaction_result lands; that output then tells completed
      // (a plan handed back) from cancelled (dismissed, `{ dismissed: true }`).
      const result = resultFor(block.toolUseId);
      const status = !result ? "open" : result.dismissed === true ? "cancelled" : "completed";
      return (
        <HandoffCard
          key={`handoff-${block.toolUseId}`}
          appId={block.appId}
          agentName={block.agentName}
          agentLabel={agentLabel}
          summary={summary}
          status={status}
        />
      );
    }
    case "interaction_result":
      // The resolution turn's user-side part adds nothing to the bubble — an
      // inline component re-renders read-only from its stored result, and a
      // handoff's visible outcome is the calling agent's reply.
      return null;
    case "approval_card":
      if (!block.approvalId || !block.preview) return null;
      // Keying on approvalId rather than index keeps internal state
      // (polling, form fields) glued to the right block when surrounding
      // blocks reorder.
      return (
        <ApprovalCard
          key={`approval-${block.approvalId}`}
          approvalId={block.approvalId}
          actionName={block.actionName}
          preview={block.preview}
          status={(block.status as ApprovalCardStatus | undefined) ?? "pending"}
          onResolved={onApprovalResolved ?? (() => {})}
        />
      );
    case "result":
      return block.accounting ? (
        <UsageSummaryBlock key={key} accounting={block.accounting} />
      ) : null;
    case "error":
      return (
        <ErrorRunBlock
          key={key}
          error={typeof block.error === "string" ? block.error : (block.error?.message ?? "")}
          accounting={block.accounting}
          code={block.code}
          provider={block.provider}
          reason={block.reason}
        />
      );
    default:
      return null;
  }
}

// Render a flat block list (no trace shell). Used for assistant-role messages
// that store MessagePart[] (text + approval_card) directly, and for the trace
// drawer's run blocks. Pairs ordinary tool and first-class subagent lifecycle
// blocks into one expandable row per invocation.
export function renderFlatBlocks(blocks: StreamBlock[], options: RenderBlockOptions = {}) {
  const { live = false } = options;
  // Index results by provider tool-use ID (or ordinary tool name as a legacy
  // fallback) so each paired step renders once.
  const resultsByUseId = new Map<string, StreamBlock>();
  const resultsByTool = new Map<string, StreamBlock[]>();
  const subagentResultsByUseId = new Map<string, StreamBlock>();
  for (const block of blocks) {
    if (block.type === "subagent_result") {
      if (block.toolUseId) subagentResultsByUseId.set(block.toolUseId, block);
    } else if (block.type === "tool_result") {
      if (block.toolUseId) resultsByUseId.set(block.toolUseId, block);
      if (block.tool) {
        const bucket = resultsByTool.get(block.tool);
        if (bucket) bucket.push(block);
        else resultsByTool.set(block.tool, [block]);
      }
    }
  }

  const consumedResults = new Set<StreamBlock>();
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    if (block.type === "tool_use") {
      const paired = pickResult(block, resultsByUseId, resultsByTool, consumedResults);
      if (paired) consumedResults.add(paired);
      nodes.push(
        <ToolStepBlock
          key={i}
          tool={block.tool}
          input={block.input}
          output={paired?.type === "tool_result" ? paired.output : undefined}
          status={toolStepStatus(paired)}
          durationMs={stepDurationMs(block, paired)}
          hasResult={paired !== null}
          live={live}
        />,
      );
      continue;
    }

    if (block.type === "subagent_start") {
      const paired = block.toolUseId ? (subagentResultsByUseId.get(block.toolUseId) ?? null) : null;
      if (paired) consumedResults.add(paired);
      if (!block.agentName || !block.sessionId || !block.turnId) continue;
      const status =
        paired?.type === "subagent_result" && paired.status
          ? (paired.status as "completed" | "failed" | "cancelled")
          : "running";
      nodes.push(
        <SubagentStepBlock
          key={i}
          agentName={block.agentName}
          input={block.input}
          sessionId={block.sessionId}
          turnId={block.turnId}
          status={status}
          output={paired?.type === "subagent_result" ? paired.output : undefined}
          error={
            paired?.type === "subagent_result" && typeof paired.error === "object"
              ? paired.error
              : undefined
          }
          durationMs={subagentStepDurationMs(block, paired)}
          live={live}
        />,
      );
      continue;
    }

    if (block.type === "tool_result" || block.type === "subagent_result") {
      // Already paired above — skip the standalone render.
      if (consumedResults.has(block)) continue;
      // Orphan result (no matching start in this run): fall back to the
      // original standalone renderer so the data isn't lost.
      nodes.push(renderSingleBlock(block, i, options));
      continue;
    }

    nodes.push(renderSingleBlock(block, i, options));
  }

  return nodes;
}

function pickResult(
  use: StreamBlock,
  resultsByUseId: Map<string, StreamBlock>,
  resultsByTool: Map<string, StreamBlock[]>,
  consumedResults: Set<StreamBlock>,
): StreamBlock | null {
  if (use.type !== "tool_use") return null;
  if (use.id) {
    const byId = resultsByUseId.get(use.id);
    if (byId && !consumedResults.has(byId)) return byId;
  }
  // Name-based fallback for legacy / id-less rows. Walk the bucket and pick
  // the first result that hasn't already been paired (either by id above or
  // by an earlier same-tool fallback), so a mixed id + non-id run can't end
  // up with two tool_use rows attached to the same result.
  if (use.tool) {
    const bucket = resultsByTool.get(use.tool);
    if (!bucket) return null;
    for (const candidate of bucket) {
      if (!consumedResults.has(candidate)) return candidate;
    }
  }
  return null;
}

function toolStepStatus(result: StreamBlock | null): ToolStepStatus {
  if (!result || result.type !== "tool_result") return "running";
  return isErrorOutput(result.output) ? "error" : "ok";
}

// A tool_result is an error when its output declares failure. Providers signal
// this differently — Claude sets `isError: true`; Codex's shell tool emits
// `status: "failed"` and a non-zero `exit_code`/`exitCode`; Codex's MCP tool
// wrapper surfaces a failed call's `error` (see codex-app-server-provider.ts
// `mcpToolCall`). We accept all of these so the trace row's status dot stays
// accurate regardless of provider.
function isErrorOutput(output: unknown): boolean {
  const normalized = normalizeTracePayload(output);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return false;
  }
  const record = normalized as Record<string, unknown>;
  if (record.isError === true || record.is_error === true) return true;
  const status = record.status;
  if (typeof status === "string") {
    const s = status.toLowerCase();
    if (s === "failed" || s === "error" || s === "errored") return true;
  }
  const exitCode = record.exit_code ?? record.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0) {
    return true;
  }
  if (hasErrorPayload(record.error) || hasErrorPayload(record.errors)) return true;
  return false;
}

// A populated `error` / `errors` field — non-empty string, non-empty array, or
// non-empty object — counts as a failure. An explicit `null`/`false`/empty
// string/empty list does not, since providers commonly include the slot with
// a falsy value on success.
function hasErrorPayload(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

function stepDurationMs(use: StreamBlock, result: StreamBlock | null): number | undefined {
  if (use.type !== "tool_use") return undefined;
  if (!result || result.type !== "tool_result") return undefined;
  const start = parseTimestamp(use.startedAt);
  const end = parseTimestamp(result.endedAt);
  if (start === null || end === null) return undefined;
  const delta = end - start;
  return delta >= 0 ? delta : undefined;
}

function subagentStepDurationMs(
  start: StreamBlock,
  result: StreamBlock | null,
): number | undefined {
  if (start.type !== "subagent_start") return undefined;
  if (!result || result.type !== "subagent_result") return undefined;
  const startedAt = parseTimestamp(start.startedAt);
  const endedAt = parseTimestamp(result.endedAt);
  if (startedAt === null || endedAt === null) return undefined;
  const delta = endedAt - startedAt;
  return delta >= 0 ? delta : undefined;
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}
