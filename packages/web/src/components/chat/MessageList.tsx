import { memo, type ReactNode, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { TraceSnapshot, TraceSubagentSummary } from "@rome/api-types/trace-segments";
import { CollapsedTraceButton } from "@/components/agent-trace/AgentTrace";
import type { TraceDrawerTarget } from "@/components/agent-trace/TraceDrawer";
import { renderFlatEntries } from "@/components/chat/entries";
import { parseMessageEntries } from "@/components/chat/entries/parse-entries";
import { AgentAvatar } from "@/components/chat/AgentAvatar";
import { ChatCodeBlockStateContext } from "@/components/chat/ChatCodeBlock";
import { ConciergeTranscript } from "@/components/chat/ConciergeTranscript";
import { ModelSwitchNotice } from "@/components/chat/ModelSwitchNotice";
import { TurnActions, turnCopyText } from "@/components/chat/TurnActions";
import { DelegatedSubagentGroup } from "@/components/chat/DelegatedSubagentGroup";
import { MessageRow } from "@/components/chat/MessageRow";
import { LiveTurnActivity } from "@/components/chat/LiveTurnActivity";
import { TurnSummaryGroup } from "@/components/chat/TurnSummaryGroup";
import { TraceTrigger } from "@/components/chat/TraceTrigger";
import { UserMessage } from "@/components/chat/UserMessage";
import { lastTextMessage, turnAnswerText } from "@/components/chat/reply/reply-source";
import type { AgentIdentity, ChatRow } from "@/components/chat/chat-view";
import type { ChatMessage } from "@/lib/chat-types";

// The block-level callbacks + resolved-interaction map threaded into
// renderFlatEntries — a single bag instead of six loose props.
export interface BlockActions {
  onApprovalResolved: () => void;
  onSubmitAppComponent: (
    sessionId: string,
    toolUseId: string,
    output: Record<string, unknown>,
    summary?: string,
  ) => void | Promise<void>;
  onDismissAppComponent: (sessionId: string, toolUseId: string) => void | Promise<void>;
  interactionResults: Map<string, Record<string, unknown>>;
}

// The transient live preview of the floor session's in-flight turn — only the
// block being typed right now. Completed blocks (commentary) and cards are
// persisted live and render in the transcript above this tail.
export interface LivePreview {
  isStreaming: boolean;
  runningTurnId: string | null;
  snapshot: TraceSnapshot | null;
  text: string;
  blockIx?: number;
  /** The full SSE text, which may be ahead of the typewriter preview. */
  sourceText?: string;
  textThroughOrdinal?: number;
  identity: AgentIdentity;
}

// While inline share selection is on (`selection` is set), every selectable turn
// in the transcript gets a checkbox + click target so the guardian picks the
// turns to freeze directly on the messages instead of in a separate list. Only
// rows belonging to `selectableSessionId` (the main session) are checkable —
// handoff child turns ride along with their parent automatically.
export interface ShareSelection {
  selectedTurns: Set<string>;
  selectableSessionId: string;
  onToggleTurn: (turnId: string) => void;
}

export interface MessageListProps {
  // Pre-grouped speaker rows (built in chat-view, memoized in Chat).
  rows: ChatRow[];
  live: LivePreview;
  selection?: ShareSelection;
  // Stick-to-bottom observes this content-sized wrapper. It must NOT be the
  // flex column whose min-height is floored to the viewport: content
  // growing inside that floor wouldn't resize it, so the ResizeObserver would
  // never fire for a late-expanding component.
  contentRef: (node: HTMLElement | null) => void;
  onOpenLiveTrace: () => void;
  onOpenStoredTrace: (target: TraceDrawerTarget) => void;
  onOpenSubagentTrace?: (node: TraceSubagentSummary) => void;
  activeTraceTarget?: TraceDrawerTarget | null;
  subagentIconByName?: ReadonlyMap<string, string | null>;
  actions: BlockActions;
  // Render inline turn actions (feedback + side-chat branch) next to the copy
  // button under settled agent turns. Guardian-only, so the live chat opts in
  // while read-only surfaces (public share, sessions viewer) omit them.
  feedback?: boolean;
  /** `concierge` shows a texting transcript (see ConciergeTranscript). Defaults to `default`. */
  variant?: ChatVariant;
}

/** How a chat presents itself. `concierge` is the texting-style Concierge chat. */
export type ChatVariant = "default" | "concierge";

// Submission helpers — read a handoff child's messages to drive the composer's
// Approve affordance. Exported for Chat; pure over a message list.

// A user turn that carries actual typed text — a reply to the agent. The
// approval-resolution turn (interaction_result only, no text) does NOT count,
// so it can't supersede the card it's resolving.
function isHumanReply(msg: ChatMessage): boolean {
  return parseMessageEntries(msg).some((b) => b.type === "text" && b.content.trim().length > 0);
}

// The newest still-actionable submission: the specialist's latest submit_output
// payload, unless the guardian has since replied (which supersedes it until a
// re-submit). Drives the composer's Approve button.
export function findActiveSubmission(
  messages: ChatMessage[],
): { messageId: string; payload: Record<string, unknown> } | null {
  let active: { messageId: string; payload: Record<string, unknown> } | null = null;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const card = parseMessageEntries(msg).find((b) => b.type === "submission_card");
      if (card) active = { messageId: msg.id, payload: card.payload };
    } else if (msg.role === "user" && active && isHumanReply(msg)) {
      active = null;
    }
  }
  return active;
}

// The most recent submission payload, ignoring the supersede rule — verbal
// approval authorizes the standing submission even though the guardian's "yes"
// just superseded it for the button.
export function findLastSubmission(messages: ChatMessage[]): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const card = parseMessageEntries(msg).find((b) => b.type === "submission_card");
    if (card) return card.payload;
  }
  return null;
}

// True once the specialist has relayed the guardian's verbal approval (a
// `handback_approved` block with no later submission superseding it).
export function hasPendingApprovalConfirmation(messages: ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = parseMessageEntries(messages[i]);
    if (blocks.some((b) => b.type === "handback_approved")) return true;
    if (blocks.some((b) => b.type === "submission_card")) return false;
  }
  return false;
}

function ArchivedTraceNote() {
  const { t } = useTranslation("activity");
  return <p className="px-3 text-aux text-muted-foreground">{t("trace.archived")}</p>;
}

function renderTrace(trace: ChatMessage, onOpen: (target: TraceDrawerTarget) => void) {
  if (trace.traceArchived) return null;
  return trace.traceSummary ? (
    <TraceTrigger
      messageId={trace.id}
      sessionId={trace.sessionId}
      turnId={trace.turnId ?? null}
      summary={trace.traceSummary}
      onOpen={onOpen}
    />
  ) : null;
}

function renderSubagents(
  subagents: TraceSnapshot["summary"]["subagents"],
  onOpenSubagentTrace: ((node: TraceSubagentSummary) => void) | undefined,
  activeTraceTarget: TraceDrawerTarget | null | undefined,
  subagentIconByName: ReadonlyMap<string, string | null> | undefined,
) {
  if (!onOpenSubagentTrace || !subagents?.length) return undefined;
  return (
    <DelegatedSubagentGroup
      subagents={subagents}
      selected={activeTraceTarget}
      agentIconByName={subagentIconByName}
      onOpenSubagentTrace={onOpenSubagentTrace}
    />
  );
}

// Persisted WebChat text blocks retain the same identity as their live SSE
// preview. Build the lookup once per transcript change; token frames then use
// a direct `(turnId, blockIx)` lookup instead of reconstructing block order.
function indexPersistedTextRows(rows: ChatRow[]): Map<string, ChatRow> {
  const index = new Map<string, ChatRow>();
  for (const row of rows) {
    if (row.kind !== "agent") continue;
    for (const message of row.messages) {
      if (!message.turnId) continue;
      for (const part of parseMessageEntries(message)) {
        if (part.type !== "text" || part.blockIx === undefined) continue;
        index.set(`${message.turnId}:${part.blockIx}`, row);
      }
    }
  }
  return index;
}

// Stable row keys preserve inline-card drafts when the live block moves on or
// the turn ends. Memoization keeps token updates out of the historical rows.
const RowView = memo(function RowView({
  row,
  live,
  actions,
  onOpenLiveTrace,
  onOpenStoredTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
  feedback = false,
}: {
  row: ChatRow;
  live: LivePreview | null;
  actions: BlockActions;
  onOpenLiveTrace: () => void;
  onOpenStoredTrace: (target: TraceDrawerTarget) => void;
  onOpenSubagentTrace?: (node: TraceSubagentSummary) => void;
  activeTraceTarget?: TraceDrawerTarget | null;
  subagentIconByName?: ReadonlyMap<string, string | null>;
  feedback?: boolean;
}) {
  if (row.kind === "user") return <UserMessage msg={row.message} />;
  if (row.kind === "model_switch") return <ModelSwitchNotice model={row.model} />;
  const avatar = <AgentAvatar iconUrl={row.identity.iconUrl} label={row.identity.name} />;
  if (row.kind === "trace") {
    const summary = row.message.traceSummary;
    const subagents = summary?.subagents;
    const plan = summary?.plan;
    return (
      <MessageRow
        name={row.identity.name}
        avatar={avatar}
        subtitle={renderTrace(row.message, onOpenStoredTrace)}
        headerAccessory={renderSubagents(
          subagents,
          onOpenSubagentTrace,
          activeTraceTarget,
          subagentIconByName,
        )}
      >
        {row.message.traceArchived ? <ArchivedTraceNote /> : null}
        {plan?.steps.length ? <TurnSummaryGroup plan={plan} live={false} /> : null}
      </MessageRow>
    );
  }
  // Running turn: its persisted trace isn't written yet, so the live trace button
  // carries it. Settled turn: its stored trace.
  const subtitle = live ? (
    <CollapsedTraceButton summary={live.snapshot?.summary} onClick={onOpenLiveTrace} live />
  ) : row.trace ? (
    renderTrace(row.trace, onOpenStoredTrace)
  ) : undefined;
  // Copy appears once the turn settles (`live` gone) and only when it produced
  // text — a card-only turn has nothing raw to copy.
  const copyText = live ? "" : turnCopyText(row.messages);
  // A row can group commentary and a final answer, so use its last saved message.
  const createdAt = live ? undefined : row.messages.at(-1)?.createdAt;
  // Replying to a settled turn quotes its answer, named by the turn's last row with text.
  const replyRow = live ? undefined : lastTextMessage(row.messages);
  // Feedback rides the same settled action row; it needs the turn identity.
  const feedbackTurn = feedback && !live ? rowTurnRef(row) : null;
  const showFeedback = !!feedbackTurn?.turnId && !!feedbackTurn.sessionId;
  const summary = live?.snapshot?.summary ?? row.trace?.traceSummary;
  const showBranch = showFeedback && summary?.turnStatus === "completed";
  const subagents = summary?.subagents;
  const recapMessageId = row.messages.find((message) =>
    parseMessageEntries(message).some((block) => block.type === "turn_recap"),
  )?.id;
  return (
    <MessageRow
      name={row.identity.name}
      avatar={avatar}
      subtitle={subtitle}
      headerAccessory={renderSubagents(
        subagents,
        onOpenSubagentTrace,
        activeTraceTarget,
        subagentIconByName,
      )}
      className="group"
      footer={
        <TurnActions
          copyText={copyText}
          feedbackTurn={
            showFeedback && feedbackTurn?.turnId
              ? { sessionId: feedbackTurn.sessionId, turnId: feedbackTurn.turnId }
              : null
          }
          showBranch={showBranch}
          createdAt={createdAt}
          reply={
            replyRow
              ? {
                  messageId: replyRow.id,
                  sessionId: replyRow.sessionId,
                  author: "agent",
                  text: turnAnswerText(row.messages),
                }
              : null
          }
        />
      }
    >
      {!live && row.trace?.traceArchived ? <ArchivedTraceNote /> : null}
      {row.messages.map((m) => {
        const blocks = parseMessageEntries(m);
        if (m.id !== recapMessageId) {
          return (
            <div key={m.id} className="flex flex-col gap-1">
              {renderFlatEntries(blocks, {
                ...actions,
                sessionId: m.sessionId,
                turnId: m.turnId ?? undefined,
                transcript: { live: !!live },
              })}
            </div>
          );
        }

        const recapIndex = blocks.findIndex((block) => block.type === "turn_recap");
        const recap = blocks[recapIndex];
        return (
          <div key={m.id} className="flex flex-col gap-1">
            {renderFlatEntries(blocks.slice(0, recapIndex), {
              ...actions,
              sessionId: m.sessionId,
              turnId: m.turnId ?? undefined,
              transcript: { live: !!live },
            })}
            <TurnSummaryGroup
              plan={summary?.plan}
              live={!!live}
              recap={
                recap?.type === "turn_recap"
                  ? {
                      content: recap.content,
                      audioUrl: recap.audioUrl,
                      audioMimeType: recap.audioMimeType,
                      audioDurationMs: recap.audioDurationMs,
                    }
                  : undefined
              }
            />
            {renderFlatEntries(blocks.slice(recapIndex + 1), {
              ...actions,
              sessionId: m.sessionId,
              turnId: m.turnId ?? undefined,
              transcript: { live: !!live },
            })}
          </div>
        );
      })}
      {live?.text ? (
        // rome-live-caret appends the pulsing live dot after the last rendered
        // character (see globals.css).
        <div className="rome-live-caret">
          {renderFlatEntries([{ type: "text", content: live.text, blockIx: live.blockIx ?? 0 }], {
            ...actions,
            turnId: live.runningTurnId ?? undefined,
            transcript: { live: true },
          })}
        </div>
      ) : null}
      {live ? (
        <LiveTurnActivity
          snapshot={live.snapshot}
          textThroughOrdinal={live.textThroughOrdinal}
          hasText={!!live.text}
          entranceKey={typingEntranceKey(live)}
        />
      ) : null}
      {recapMessageId ? null : <TurnSummaryGroup plan={summary?.plan} live={!!live} />}
    </MessageRow>
  );
});

// The typing bubble pops in again each time the agent goes back to work after
// a text block, so its key moves with the text it follows.
function typingEntranceKey(live: LivePreview): string {
  return `${live.runningTurnId ?? "no-turn"}:typing:${live.textThroughOrdinal ?? -1}`;
}

// A block without an agent row at its transcript position carries its own header.
// Persisted cards stay in RowView so their local state survives the handoff.
function StandaloneLiveTail({
  live,
  actions,
  onOpenLiveTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
}: {
  live: LivePreview;
  actions: BlockActions;
  onOpenLiveTrace: () => void;
  onOpenSubagentTrace?: (node: TraceSubagentSummary) => void;
  activeTraceTarget?: TraceDrawerTarget | null;
  subagentIconByName?: ReadonlyMap<string, string | null>;
}) {
  return (
    <MessageRow
      name={live.identity.name}
      avatar={<AgentAvatar iconUrl={live.identity.iconUrl} label={live.identity.name} />}
      subtitle={
        <CollapsedTraceButton summary={live.snapshot?.summary} onClick={onOpenLiveTrace} live />
      }
      headerAccessory={renderSubagents(
        live.snapshot?.summary.subagents,
        onOpenSubagentTrace,
        activeTraceTarget,
        subagentIconByName,
      )}
    >
      {live.text ? (
        <div className="rome-live-caret">
          {renderFlatEntries([{ type: "text", content: live.text, blockIx: live.blockIx ?? 0 }], {
            ...actions,
            turnId: live.runningTurnId ?? undefined,
            transcript: { live: true },
          })}
        </div>
      ) : null}
      <LiveTurnActivity
        snapshot={live.snapshot}
        textThroughOrdinal={live.textThroughOrdinal}
        hasText={!!live.text}
        entranceKey={typingEntranceKey(live)}
      />
      <TurnSummaryGroup plan={live.snapshot?.summary.plan} live />
    </MessageRow>
  );
}

// The (turnId, sessionId) a row belongs to, for inline share selection. Null
// turnId rows (transient/optimistic) and the standalone live tail aren't
// selectable.
function rowTurnRef(row: ChatRow): { turnId: string | null; sessionId: string } {
  if (row.kind === "model_switch") return { turnId: null, sessionId: row.sessionId };
  if (row.kind === "user" || row.kind === "trace") {
    return { turnId: row.message.turnId ?? null, sessionId: row.message.sessionId };
  }
  const first = row.messages[0] ?? row.trace;
  return { turnId: first?.turnId ?? null, sessionId: first?.sessionId ?? "" };
}

// Wraps a transcript row with a checkbox + full-row click target during share
// selection. The overlay button sits above the row, so in selection mode a
// click toggles the turn instead of activating links/cards underneath.
function SelectableRow({
  selected,
  onToggle,
  label,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        className={`rounded-8 pl-9 transition-colors ${selected ? "bg-primary/5" : "opacity-60"}`}
      >
        {children}
      </div>
      <span
        className={`pointer-events-none absolute left-2 top-3 flex size-5 items-center justify-center rounded-4 border ${
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-surface"
        }`}
      >
        {selected && <Check className="size-3.5" />}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={selected}
        aria-label={label}
        className="absolute inset-0 rounded-8 ring-primary/40 focus-visible:outline-none focus-visible:ring-2"
      />
    </div>
  );
}

export function MessageList({
  rows,
  live,
  selection,
  contentRef,
  onOpenLiveTrace,
  onOpenStoredTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
  actions,
  feedback,
  variant = "default",
}: MessageListProps) {
  if (variant === "concierge") {
    return (
      <ConciergeTranscript
        rows={rows}
        live={live}
        actions={actions}
        contentRef={contentRef}
        feedback={feedback}
      />
    );
  }
  return (
    <TranscriptMessageList
      rows={rows}
      live={live}
      selection={selection}
      contentRef={contentRef}
      onOpenLiveTrace={onOpenLiveTrace}
      onOpenStoredTrace={onOpenStoredTrace}
      onOpenSubagentTrace={onOpenSubagentTrace}
      activeTraceTarget={activeTraceTarget}
      subagentIconByName={subagentIconByName}
      actions={actions}
      feedback={feedback}
    />
  );
}

function TranscriptMessageList({
  rows,
  live,
  selection,
  contentRef,
  onOpenLiveTrace,
  onOpenStoredTrace,
  onOpenSubagentTrace,
  activeTraceTarget,
  subagentIconByName,
  actions,
  feedback,
}: Omit<MessageListProps, "variant">) {
  const codeBlockDisclosureState = useRef(new Map<string, boolean>()).current;
  const runningTurnId = live.isStreaming ? live.runningTurnId : null;
  const blockKey = runningTurnId ? `${runningTurnId}:${live.blockIx ?? 0}` : null;
  const sourceText = live.sourceText ?? live.text;
  const persistedTextRows = useMemo(() => indexPersistedTextRows(rows), [rows]);
  const persistedRow = blockKey ? persistedTextRows.get(blockKey) : undefined;
  const nextAnchor = { blockKey, afterRowKey: persistedRow?.key ?? rows.at(-1)?.key ?? null };
  const [anchor, setAnchor] = useState(nextAnchor);
  // A user input cannot relocate an output block already on screen. Only a
  // new block picks a new position. A persisted copy takes over the live text.
  let currentAnchor = anchor;
  if (anchor.blockKey !== blockKey) {
    currentAnchor = nextAnchor;
    setAnchor(nextAnchor);
  }
  const anchorRow = rows.find(
    (row) => row.key === (persistedRow?.key ?? currentAnchor.afterRowKey),
  );
  const runningRow =
    runningTurnId &&
    anchorRow?.kind === "agent" &&
    anchorRow.messages.some((m) => m.turnId === runningTurnId)
      ? anchorRow
      : undefined;
  // useSmoothText resets after render. Do not place the old block's last frame
  // at the new block's position while that effect catches up.
  const preview = !persistedRow && sourceText.startsWith(live.text) ? live : { ...live, text: "" };
  const standalone =
    live.isStreaming && !runningRow ? (
      <StandaloneLiveTail
        key={`live:${blockKey}`}
        live={preview}
        actions={actions}
        onOpenLiveTrace={onOpenLiveTrace}
        onOpenSubagentTrace={onOpenSubagentTrace}
        activeTraceTarget={activeTraceTarget}
        subagentIconByName={subagentIconByName}
      />
    ) : null;

  const content = (
    <div className="flex-1">
      <div ref={contentRef} data-chat-transcript className="mx-auto max-w-5xl px-4 pt-4 md:px-6">
        {rows.flatMap((row) => {
          const isRunning = row === runningRow;
          const view = (
            <RowView
              key={row.key}
              row={row}
              live={isRunning ? preview : null}
              actions={actions}
              onOpenLiveTrace={onOpenLiveTrace}
              onOpenStoredTrace={onOpenStoredTrace}
              onOpenSubagentTrace={onOpenSubagentTrace}
              activeTraceTarget={activeTraceTarget}
              subagentIconByName={subagentIconByName}
              feedback={feedback}
            />
          );
          const tail = row === anchorRow ? standalone : null;
          // The timeline rail locates its scroll targets by this attribute, and
          // Chat paints the post-jump landing tint on the same wrapper. It goes
          // around the view inside every branch, so share mode cannot strip it.
          // A plain div with no classes adds no box: UserMessage's own `mb-4`
          // still collapses through it, so row rhythm is unchanged.
          // An agent row is addressable by every message id it holds: a reply
          // names the turn by its last message, and a jump finds it by that id.
          const anchorIds =
            row.kind === "user"
              ? row.message.id
              : row.kind === "agent"
                ? row.messages.map((message) => message.id).join(" ")
                : null;
          const anchored = (node: ReactNode, key?: string) =>
            anchorIds ? (
              <div key={key} data-timeline-anchor={anchorIds}>
                {node}
              </div>
            ) : (
              node
            );
          if (!selection) return [anchored(view, row.key), tail];
          const { turnId, sessionId } = rowTurnRef(row);
          if (!turnId || sessionId !== selection.selectableSessionId) {
            // Not selectable (child-session row, or no turn): still dim it so the
            // selection state reads clearly across the whole transcript.
            return [
              <div key={row.key} className="pl-9 opacity-60">
                {anchored(view)}
              </div>,
              tail,
            ];
          }
          return [
            <SelectableRow
              key={row.key}
              selected={selection.selectedTurns.has(turnId)}
              onToggle={() => selection.onToggleTurn(turnId)}
              label={selection.selectedTurns.has(turnId) ? "Deselect message" : "Select message"}
            >
              {anchored(view)}
            </SelectableRow>,
            tail,
          ];
        })}
        {!anchorRow ? standalone : null}
      </div>
    </div>
  );
  return (
    <ChatCodeBlockStateContext.Provider value={codeBlockDisclosureState}>
      {content}
    </ChatCodeBlockStateContext.Provider>
  );
}
