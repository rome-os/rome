import type { ChatEntry } from "@/lib/chat-types";
import { normalizeTracePayload } from "@/lib/trace-format";
import { interactionResultKey } from "@/components/chat/chat-view";
import { ChatBubble } from "@/components/chat/ChatBubble";
import { TranscriptEntry } from "@/components/chat/TranscriptEntry";
import { ApprovalCard } from "../approval/ApprovalCard";
import { AgentCallView } from "./AgentCallView";
import { AiToolsCard } from "./AiToolsCard";
import { AppComponentView } from "./AppComponentView";
import { ErrorRunView } from "./ErrorEventView";
import { HandoffCard } from "./HandoffCard";
import { QuestionCard } from "./QuestionCard";
import { RoutineDraftCard } from "./RoutineDraftCard";
import { SubagentCallView } from "./SubagentCallView";
import { TextBlock } from "./TextBlock";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolResultBlock } from "./ToolResultBlock";
import { ToolCallView, type ToolCallStatus } from "./ToolCallView";
import { ToolUseBlock } from "./ToolUseBlock";
import { TurnRecapView } from "./TurnRecapView";
import { UsageSummaryView } from "./UsageSummaryView";

export interface RenderEntryOptions {
  onApprovalResolved?: () => void;
  compact?: boolean;
  toolUseInput?: unknown;
  /** Trace drawer is currently live-streaming (forwarded to ToolCallView). */
  live?: boolean;
  /** Session that owns the message these blocks belong to — namespaces resolved
   * interaction state and routes submissions to the right session in the merged
   * (multi-session) transcript. */
  sessionId?: string;
  /** Turn that owns the rendered text blocks, used to preserve disclosure state
   * when a live block is replaced by its persisted transcript representation. */
  turnId?: string;
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
  /** Set by the chat transcript: each text block renders as its own bubble,
   * and every entry comes in once while `live` (its turn is running). */
  transcript?: { live: boolean };
}

export function renderSingleEntry(
  block: ChatEntry,
  key: string | number,
  options: RenderEntryOptions = {},
) {
  const {
    onApprovalResolved,
    compact = false,
    toolUseInput,
    sessionId,
    turnId,
    interactionResults,
    onSubmitAppComponent,
    onDismissAppComponent,
    transcript,
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
        <AgentCallView
          key={key}
          agent={block.agent}
          sessionId={block.sessionId}
          romeSession={block.romeSession}
          systemPrompt={block.systemPrompt}
          userPrompt={block.userPrompt}
        />
      );
    case "thinking":
      return <ThinkingBlock key={key} content={block.content} />;
    case "tool_use":
      return <ToolUseBlock key={key} tool={block.tool} input={block.input} />;
    case "tool_result":
      return (
        <ToolResultBlock key={key} tool={block.tool} output={block.output} input={toolUseInput} />
      );
    case "subagent_start":
      return (
        <SubagentCallView
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
      return (
        <SubagentCallView
          key={key}
          agentName={block.agentName}
          sessionId={block.sessionId}
          turnId={block.turnId}
          status={block.status}
          output={block.status === "completed" ? block.output : undefined}
          error={block.status === "completed" ? undefined : block.error}
        />
      );
    case "text": {
      const blockIx = textBlockIx(block);
      const disclosureStateKey =
        turnId !== undefined && blockIx !== undefined ? `${turnId}:${blockIx}` : undefined;
      // In the transcript every text block is its own bubble, so consecutive
      // narration reads as separate utterances under one speaker.
      if (transcript) {
        return (
          <ChatBubble key={key} tone="received">
            <TextBlock
              content={block.content}
              compact={compact}
              disclosureStateKey={disclosureStateKey}
            />
          </ChatBubble>
        );
      }
      // In-turn narration: give each commentary its own gap so consecutive
      // narration reads as separate utterances under one speaker (not a run-on
      // paragraph). Same text styling as the final answer. The final answer
      // renders bare, as before.
      return block.turnPhase === "commentary" ? (
        <div key={key} className="mb-3">
          <TextBlock
            content={block.content}
            compact={compact}
            disclosureStateKey={disclosureStateKey}
          />
        </div>
      ) : (
        <TextBlock
          key={key}
          content={block.content}
          compact={compact}
          disclosureStateKey={disclosureStateKey}
        />
      );
    }
    case "turn_recap":
      return (
        <TurnRecapView
          key={key}
          content={block.content}
          audioUrl={block.audioUrl}
          audioMimeType={block.audioMimeType}
          audioDurationMs={block.audioDurationMs}
        />
      );
    case "routine_draft_card":
      return <RoutineDraftCard key={`routine-${block.toolUseId}`} draft={block.draft} />;
    case "submission_card":
      // The borrowed agent's submit_output is not rendered in the conversation
      // flow — the result already lives on the app's own surface beside the
      // chat, and the approval gate is the composer's Approve button. The block
      // stays in the message stream only as the signal that a submission is
      // pending (read by findActiveSubmission to drive that button).
      return null;
    case "pending_interaction": {
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
        <AppComponentView
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
      // Keying on approvalId rather than index keeps internal state
      // (polling, form fields) glued to the right block when surrounding
      // blocks reorder.
      return (
        <ApprovalCard
          key={`approval-${block.approvalId}`}
          approvalId={block.approvalId}
          actionName={block.actionName}
          preview={block.preview}
          status={block.status}
          onResolved={onApprovalResolved ?? (() => {})}
        />
      );
    case "result":
      return block.accounting ? <UsageSummaryView key={key} accounting={block.accounting} /> : null;
    case "error":
      return (
        <ErrorRunView
          key={key}
          error={block.error}
          accounting={"accounting" in block ? block.accounting : undefined}
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
export function renderFlatEntries(blocks: ChatEntry[], options: RenderEntryOptions = {}) {
  const { live = false } = options;
  // Index results by provider tool-use ID (or ordinary tool name as a legacy
  // fallback) so each paired step renders once.
  const resultsByUseId = new Map<string, ToolResultEntry>();
  const resultsByTool = new Map<string, ToolResultEntry[]>();
  const subagentResultsByUseId = new Map<string, SubagentResultEntry>();
  for (const block of blocks) {
    if (block.type === "subagent_result") {
      subagentResultsByUseId.set(block.toolUseId, block);
    } else if (block.type === "tool_result") {
      if (block.toolUseId) resultsByUseId.set(block.toolUseId, block);
      const bucket = resultsByTool.get(block.tool);
      if (bucket) bucket.push(block);
      else resultsByTool.set(block.tool, [block]);
    }
  }

  const consumedResults = new Set<ChatEntry>();
  const nodes: React.ReactNode[] = [];

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];

    if (block.type === "tool_use") {
      const paired = pickResult(block, resultsByUseId, resultsByTool, consumedResults);
      if (paired) consumedResults.add(paired);
      nodes.push(
        <ToolCallView
          key={i}
          tool={block.tool}
          input={block.input}
          output={paired?.output}
          status={toolCallStatus(paired)}
          durationMs={toolCallDurationMs(block, paired)}
          hasResult={paired !== null}
          live={live}
        />,
      );
      continue;
    }

    if (block.type === "subagent_start") {
      const paired = subagentResultsByUseId.get(block.toolUseId) ?? null;
      if (paired) consumedResults.add(paired);
      nodes.push(
        <SubagentCallView
          key={i}
          agentName={block.agentName}
          input={block.input}
          sessionId={block.sessionId}
          turnId={block.turnId}
          status={paired?.status ?? "running"}
          output={paired?.status === "completed" ? paired.output : undefined}
          error={paired && paired.status !== "completed" ? paired.error : undefined}
          durationMs={subagentCallDurationMs(block, paired)}
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
      nodes.push(transcriptEntry(renderSingleEntry(block, i, options), block, i, options));
      continue;
    }

    nodes.push(transcriptEntry(renderSingleEntry(block, i, options), block, i, options));
  }

  return nodes;
}

// In the transcript, wraps a rendered entry so it comes in once while its turn
// is live. The key matches between a live text preview and its saved copy,
// both of which carry the turn and the block index.
function transcriptEntry(
  node: React.ReactNode,
  block: ChatEntry,
  index: number,
  { transcript, turnId }: RenderEntryOptions,
): React.ReactNode {
  if (!transcript || node === null || node === undefined) return node;
  const id =
    block.type === "text"
      ? `text:${textBlockIx(block) ?? index}`
      : `${block.type}:${("toolUseId" in block ? block.toolUseId : undefined) ?? index}`;
  return (
    <TranscriptEntry
      key={`entry:${id}`}
      entryKey={`${turnId ?? "no-turn"}:${id}`}
      live={transcript.live}
      kind={block.type === "text" ? "bubble" : "card"}
    >
      {node}
    </TranscriptEntry>
  );
}

type ToolUseEntry = Extract<ChatEntry, { type: "tool_use" }>;
type ToolResultEntry = Extract<ChatEntry, { type: "tool_result" }>;
type SubagentStartEntry = Extract<ChatEntry, { type: "subagent_start" }>;
type SubagentResultEntry = Extract<ChatEntry, { type: "subagent_result" }>;

// Only stored WebChat text parts carry a block index; trace text does not.
function textBlockIx(block: Extract<ChatEntry, { type: "text" }>): number | undefined {
  return "blockIx" in block ? block.blockIx : undefined;
}

function pickResult(
  use: ToolUseEntry,
  resultsByUseId: Map<string, ToolResultEntry>,
  resultsByTool: Map<string, ToolResultEntry[]>,
  consumedResults: Set<ChatEntry>,
): ToolResultEntry | null {
  if (use.id) {
    const byId = resultsByUseId.get(use.id);
    if (byId && !consumedResults.has(byId)) return byId;
  }
  // Name-based fallback for legacy / id-less rows. Walk the bucket and pick
  // the first result that hasn't already been paired (either by id above or
  // by an earlier same-tool fallback), so a mixed id + non-id run can't end
  // up with two tool_use rows attached to the same result.
  for (const candidate of resultsByTool.get(use.tool) ?? []) {
    if (!consumedResults.has(candidate)) return candidate;
  }
  return null;
}

function toolCallStatus(result: ToolResultEntry | null): ToolCallStatus {
  if (!result) return "running";
  if (result.isError !== undefined) return result.isError ? "error" : "ok";
  return isLegacyErrorOutput(result.output) ? "error" : "ok";
}

// A result without `tool_result.isError` (recorded before the flag existed, or
// from a producer that cannot tell, such as Claude's subagent fallback or turn
// middleware) falls back to each provider's own failure signal: Claude's `isError`,
// Codex's `status: "failed"` and non-zero `exit_code`/`exitCode`, and a
// Codex MCP call's `error`.
function isLegacyErrorOutput(output: unknown): boolean {
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

function toolCallDurationMs(use: ToolUseEntry, result: ToolResultEntry | null): number | undefined {
  if (!result) return undefined;
  const start = parseTimestamp(use.startedAt);
  const end = parseTimestamp(result.endedAt);
  if (start === null || end === null) return undefined;
  const delta = end - start;
  return delta >= 0 ? delta : undefined;
}

function subagentCallDurationMs(
  start: SubagentStartEntry,
  result: SubagentResultEntry | null,
): number | undefined {
  if (!result) return undefined;
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
