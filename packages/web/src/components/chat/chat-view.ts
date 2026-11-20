import type { QuotaSwitchPart } from "@rome/api-types/chat";
import { LOCATION_CARD_ID } from "@rome/api-types/location-card";
import type { SystemInputSource } from "@rome/api-types/trace-segments";
import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";
import { parseEntries, parseMessageEntries } from "@/components/chat/entries/parse-entries";

// Pure derivation: per-session message lists → one renderable view. No React,
// no fetch — fully unit-testable.

export interface AgentIdentity {
  name: string;
  iconUrl: string | null;
}

export interface ChatView {
  // The main session's transcript, ordered.
  displayMessages: ChatMessage[];
  // sessionId → avatar + name for the speaker rows.
  identityBySession: Map<string, AgentIdentity>;
  // toolUseId → resolved interaction output (for inline cards).
  interactionResults: Map<string, Record<string, unknown>>;
}

// Shared by the user bubble and the timeline rail, so the rail labels its dots
// with the same plain text the bubble renders.
export function userMessageText(content: string): string {
  return parseEntries(content)
    .flatMap((b) => (b.type === "text" ? [b.content] : []))
    .join("\n");
}

// Key resolved-interaction state by (session, toolUseId). Provider toolUseIds
// like `item_0` recur every turn AND across sessions, so the merged transcript
// must namespace them per session or one session's resolved card would mark a
// same-id card in another session resolved.
export function interactionResultKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`;
}

// The host's own built-in cards (vs an app's inline component):
// the only suspensions auto-dismissed by a free-text reply, since typing in
// chat instead of using the card is the natural "skip this" for a question, a
// location share or a provider sign-in, but not for an app's half-filled form.
//
// The connect-AI card has to be here as well as the question card: it resolves
// itself once a provider signs in, so an earlier copy left open would submit a
// second `{ connected: true }` and drive the script a step past where the
// guardian is.
const AUTO_DISMISSED_COMPONENT_IDS = new Set(["question-card", "ai-tools-card", LOCATION_CARD_ID]);

function isAutoDismissedCard(b: TranscriptPart): boolean {
  return (
    b.type === "pending_interaction" &&
    b.render.builtin === true &&
    AUTO_DISMISSED_COMPONENT_IDS.has(b.render.componentId ?? "")
  );
}

// (session, toolUseId) → resolved interaction output. Ordered pass so a fresh
// card clears a recycled id's stale result within its own session.
//
// Auto-dismiss: an open `ask_question` card whose session then receives a
// free-text reply (the guardian answered in chat instead of using the card)
// resolves to `{ dismissed: true }` — it locks read-only rather than sitting
// interactive forever. Derived from transcript order, so it survives reload.
function buildInteractionResults(messages: ChatMessage[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  // Per-session set of built-in card toolUseIds still awaiting a result.
  const openCards = new Map<string, Set<string>>();
  for (const msg of messages) {
    let userTextReply = false;
    for (const b of parseMessageEntries(msg)) {
      if (msg.role === "assistant" && b.type === "pending_interaction") {
        map.delete(interactionResultKey(msg.sessionId, b.toolUseId));
        if (isAutoDismissedCard(b)) {
          const open = openCards.get(msg.sessionId) ?? new Set<string>();
          open.add(b.toolUseId);
          openCards.set(msg.sessionId, open);
        }
      } else if (msg.role === "user" && b.type === "interaction_result") {
        map.set(interactionResultKey(msg.sessionId, b.toolUseId), b.output);
        openCards.get(msg.sessionId)?.delete(b.toolUseId);
      } else if (msg.role === "user" && b.type === "text" && b.content.trim()) {
        // A genuine typed reply (not a card resolution, which is parts-only).
        userTextReply = true;
      }
    }
    if (userTextReply) {
      const open = openCards.get(msg.sessionId);
      if (open) {
        for (const toolUseId of open) {
          map.set(interactionResultKey(msg.sessionId, toolUseId), { dismissed: true });
        }
        open.clear();
      }
    }
  }
  return map;
}

export function buildChatView(
  messages: Map<string, ChatMessage[]>,
  mainSessionId: string,
  mainIdentity: AgentIdentity,
): ChatView {
  // Messages stand in the order the server sent them, which is the order they
  // were said. A turn's trace is looked up by its turn id and shown as its
  // subtitle, so its position in the list doesn't matter.
  const displayMessages = messages.get(mainSessionId) ?? [];
  return {
    displayMessages,
    identityBySession: new Map([[mainSessionId, mainIdentity]]),
    interactionResults: buildInteractionResults(displayMessages),
  };
}

/** Assistant messages in the latest turn, after its last guardian input.
 * An unpersisted running turn supersedes the saved reply as well. */
export function currentReplyMessages(
  view: Pick<ChatView, "displayMessages">,
  runningTurnId: string | null = null,
): ChatMessage[] {
  const messages = view.displayMessages;
  const latestTurnId = messages.at(-1)?.turnId;
  if (runningTurnId !== null && latestTurnId !== runningTurnId) return [];
  const reply: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.turnId !== latestTurnId || msg.role === "user") break;
    if (msg.role === "assistant") reply.push(msg);
  }
  return reply.reverse();
}

// Whether the chat is parked on a card the guardian has not answered yet (an
// ask_question card, a connect-AI card, an app component). Only the latest
// turn counts, meaning every assistant message that
// shares the turn id of its last message: the card is saved mid-turn and the
// turn's closing text and recap land after it under the same id. A card from
// an earlier turn is no longer what the agent waits on, and a backend-initiated
// turn (an approval continuation) starts a new id without a user message.
// Pass the running turn while one streams. A backend task that runs no
// recorded turn persists its messages only when it ends, so until then the
// transcript still closes on the previous turn, whose cards it has moved past.
// A recorded backend turn saves its cards mid-turn under its own id, which is
// then the running turn id, so its cards count as they land.
export function isAwaitingGuardian(
  view: Pick<ChatView, "displayMessages" | "interactionResults">,
  runningTurnId: string | null = null,
): boolean {
  return openCards(view, runningTurnId).length > 0;
}

// Whether the chat waits on a card that is the only way to answer
// (`render.requiresCard`), in the same window as isAwaitingGuardian. The
// composer locks while this holds.
export function isLockedByCard(
  view: Pick<ChatView, "displayMessages" | "interactionResults">,
  runningTurnId: string | null = null,
): boolean {
  return openCards(view, runningTurnId).some((card) => card.render.requiresCard === true);
}

type PendingCard = Extract<TranscriptPart, { type: "pending_interaction" }>;

// The unanswered cards of the latest turn, in the window
// isAwaitingGuardian describes.
function openCards(
  view: Pick<ChatView, "displayMessages" | "interactionResults">,
  runningTurnId: string | null,
): PendingCard[] {
  const cards: PendingCard[] = [];
  for (const msg of currentReplyMessages(view, runningTurnId)) {
    for (const b of parseMessageEntries(msg)) {
      if (
        b.type === "pending_interaction" &&
        !view.interactionResults.has(interactionResultKey(msg.sessionId, b.toolUseId))
      ) {
        cards.push(b);
      }
    }
  }
  return cards;
}

// Whether the latest finished turn ended with an error: the same turn_end
// status the sidebar's failed mark reads.
export function isLastTurnFailed(view: Pick<ChatView, "displayMessages">): boolean {
  const { displayMessages } = view;
  for (let i = displayMessages.length - 1; i >= 0; i--) {
    const msg = displayMessages[i];
    if (msg.role === "trace" && msg.traceSummary) {
      return msg.traceSummary.turnStatus === "error";
    }
  }
  return false;
}

// Render rows: group the flat transcript into speaker blocks. Pure data — the
// view layer turns rows into JSX. Depends on runningTurnId/isStreaming, but
// those only change at turn boundaries (not per token), so a memo on these
// inputs holds across a streaming turn.

interface RowBase {
  key: string;
}

export type ChatRow =
  | (RowBase & { kind: "user"; message: ChatMessage })
  // A reply-less turn's trace, standing on its own.
  | (RowBase & { kind: "trace"; message: ChatMessage; identity: AgentIdentity })
  // One speaker turn: identity header once, its trace, and the blocks of every
  // assistant message in the turn.
  | (RowBase & {
      kind: "agent";
      identity: AgentIdentity;
      trace: ChatMessage | null;
      messages: ChatMessage[];
    })
  // The chat moved to another model: the turn after it ran on `model`, the
  // session's turn before it on another one.
  // `fromModel` is the model of that earlier turn.
  | (RowBase & {
      kind: "model_switch";
      model: string;
      fromModel: string;
      turnId: string;
      sessionId: string;
      /** Rome moved the chat because a model hit its own limit: the note says why. */
      quota?: QuotaSwitchPart;
    })
  // The turn after it ran on what a routine, an app or another agent sent
  // into the chat, which shows as a faint line naming the source.
  | (RowBase & { kind: "automated_input"; source: SystemInputSource; turnId: string });

// The rows the last build made, by the message each starts from. A build hands
// back the row object it made before when nothing the row shows has changed, so
// the memoized row views skip a render when a message arrives. Weak, so a
// message that leaves the transcript takes its row along.
const builtRows = new WeakMap<ChatMessage, ChatRow>();
// A model-switch notice is keyed by the row it stands before.
const builtSwitches = new WeakMap<ChatRow, ChatRow>();
// So is an automated input's line.
const builtInputs = new WeakMap<ChatRow, ChatRow>();

function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return a === b || (a.name === b.name && a.iconUrl === b.iconUrl);
}

function sameRow(a: ChatRow, b: ChatRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "user") return b.kind === "user" && a.message.inputState === b.message.inputState;
  if (a.kind === "model_switch") {
    return (
      b.kind === "model_switch" &&
      a.model === b.model &&
      a.fromModel === b.fromModel &&
      a.turnId === b.turnId &&
      a.quota === b.quota
    );
  }
  if (a.kind === "automated_input") {
    return (
      b.kind === "automated_input" &&
      a.turnId === b.turnId &&
      a.source.type === b.source.type &&
      a.source.name === b.source.name
    );
  }
  if (a.kind === "trace") {
    return b.kind === "trace" && a.message === b.message && sameIdentity(a.identity, b.identity);
  }
  return (
    b.kind === "agent" &&
    sameIdentity(a.identity, b.identity) &&
    a.trace === b.trace &&
    a.messages.length === b.messages.length &&
    a.messages.every((message, index) => message === b.messages[index])
  );
}

/** `next`, or the row the last build made for `anchor` when it shows the same. */
function reuseRow(anchor: ChatMessage, next: ChatRow): ChatRow {
  const built = builtRows.get(anchor);
  if (built && sameRow(built, next)) return built;
  builtRows.set(anchor, next);
  return next;
}

export function buildRows(
  messages: ChatMessage[],
  identityBySession: Map<string, AgentIdentity>,
  fallbackIdentity: AgentIdentity,
  opts: { runningTurnId: string | null; isStreaming: boolean },
): ChatRow[] {
  const identityOf = (sid: string) => identityBySession.get(sid) ?? fallbackIdentity;

  const tracesByTurn = new Map<string, ChatMessage>();
  const turnsWithAssistant = new Set<string>();
  // Turns a provider card explains: their send did not fail, it waits on the card.
  const cardedTurns = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.turnId && m.content.includes('"provider_failure"'))
      cardedTurns.add(m.turnId);
    if (m.role === "trace" && m.turnId && (m.traceSummary || m.traceArchived))
      tracesByTurn.set(m.turnId, m);
    if (m.role === "assistant" && m.turnId) turnsWithAssistant.add(m.turnId);
  }
  const isRunningTurn = (turnId: string | null | undefined) =>
    opts.isStreaming && opts.runningTurnId != null && turnId === opts.runningTurnId;

  const rows: ChatRow[] = [];
  const renderedTraceTurns = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    // Rome's note that it moved the chat to another model is the switch
    // notice itself, saying why; the next turn's own notice is then left out.
    if (msg.role === "assistant") {
      const quota = quotaSwitchOf(msg);
      if (quota) {
        rows.push(
          reuseRow(msg, {
            kind: "model_switch",
            key: msg.id,
            model: quota.model,
            fromModel: quota.fromModel ?? "",
            turnId: msg.turnId ?? msg.id,
            sessionId: msg.sessionId,
            quota,
          }),
        );
        continue;
      }
    }
    if (msg.role === "user") {
      const calm =
        msg.inputState === "failed" && msg.turnId && cardedTurns.has(msg.turnId)
          ? { ...msg, inputState: "consumed" as const }
          : msg;
      rows.push(reuseRow(msg, { kind: "user", key: msg.id, message: calm }));
      continue;
    }
    if (msg.role === "trace") {
      if (!msg.traceSummary && !msg.traceArchived) continue;
      // Merged into the turn's grouped row when it has assistant replies; only
      // stands alone for a reply-less turn. Never mid-stream for the running
      // turn (the live trace button carries it).
      if (msg.turnId && turnsWithAssistant.has(msg.turnId)) continue;
      if (isRunningTurn(msg.turnId)) continue;
      rows.push(
        reuseRow(msg, {
          kind: "trace",
          key: msg.id,
          message: msg,
          identity: identityOf(msg.sessionId),
        }),
      );
      continue;
    }
    // Group a turn's run of assistant messages under one header: gather the
    // ones that follow this one, stepping over a same-turn trace (it's
    // rendered once as the turn's subtitle via tracesByTurn, so its position
    // in the list is irrelevant). A message of a different turn or session, or
    // a user message, ends the run.
    const group = [msg];
    let j = i + 1;
    while (
      j < messages.length &&
      msg.turnId != null &&
      messages[j].turnId === msg.turnId &&
      messages[j].sessionId === msg.sessionId &&
      (messages[j].role === "assistant" || messages[j].role === "trace")
    ) {
      if (messages[j].role === "assistant") group.push(messages[j]);
      j++;
    }
    i = j - 1;
    // A turn that only failed quietly (a silent retry, a model move, or a card
    // a later turn carries now) has nothing to show: the note or the next turn
    // says what happened.
    if (group.every(isQuietFailure)) {
      if (msg.turnId) renderedTraceTurns.add(msg.turnId);
      continue;
    }
    const turnTrace = msg.turnId ? tracesByTurn.get(msg.turnId) : undefined;
    const showTrace =
      !!turnTrace && !renderedTraceTurns.has(msg.turnId!) && !isRunningTurn(msg.turnId);
    if (showTrace) renderedTraceTurns.add(msg.turnId!);
    rows.push(
      reuseRow(msg, {
        kind: "agent",
        key: msg.id,
        identity: identityOf(msg.sessionId),
        trace: showTrace ? turnTrace! : null,
        messages: group,
      }),
    );
  }
  return withModelSwitches(rows, tracesByTurn);
}

/** The model-switch note a message is, when that is all it holds. */
function quotaSwitchOf(message: ChatMessage): QuotaSwitchPart | null {
  if (!message.content.includes('"quota_switch"')) return null;
  try {
    const parts = JSON.parse(message.content) as unknown;
    if (!Array.isArray(parts) || parts.length !== 1) return null;
    const [part] = parts as Array<Partial<QuotaSwitchPart>>;
    return part?.type === "quota_switch" && typeof part.model === "string"
      ? (part as QuotaSwitchPart)
      : null;
  } catch {
    return null;
  }
}

/** The turn and session a row belongs to, or null for a row with no turn. */
function rowTurn(row: ChatRow): { turnId: string; sessionId: string } | null {
  if (row.kind === "model_switch" || row.kind === "automated_input") return null;
  const message = row.kind === "agent" ? row.messages[0] : row.message;
  return message?.turnId ? { turnId: message.turnId, sessionId: message.sessionId } : null;
}

/**
 * Put a model-switch notice before the first row of each turn that ran on
 * another model than the same session's last turn with a known model. A turn's
 * model comes from its trace summary, so a running turn shows its notice once
 * it ends, and a turn without one changes nothing.
 */
function withModelSwitches(rows: ChatRow[], tracesByTurn: Map<string, ChatMessage>): ChatRow[] {
  const lastModelBySession = new Map<string, string>();
  const seenTurns = new Set<string>();
  const out: ChatRow[] = [];
  for (const row of rows) {
    const turn = rowTurn(row);
    if (turn && !seenTurns.has(turn.turnId)) {
      seenTurns.add(turn.turnId);
      const source = tracesByTurn.get(turn.turnId)?.traceSummary?.automatedInput;
      if (source) {
        const line: ChatRow = {
          kind: "automated_input",
          key: `automated-input:${turn.turnId}`,
          source,
          turnId: turn.turnId,
        };
        const built = builtInputs.get(row);
        if (built && sameRow(built, line)) out.push(built);
        else {
          builtInputs.set(row, line);
          out.push(line);
        }
      }
      const model = tracesByTurn.get(turn.turnId)?.traceSummary?.model;
      if (model) {
        const previous = lastModelBySession.get(turn.sessionId);
        if (previous && previous !== model) {
          const notice: ChatRow = {
            kind: "model_switch",
            key: `model-switch:${turn.turnId}`,
            model,
            fromModel: previous,
            turnId: turn.turnId,
            sessionId: turn.sessionId,
          };
          // Rome's own note about this move already stands just before.
          // Rome's own note about this move stands before it, perhaps above the
          // quiet turn that hit the limit.
          let noted = false;
          for (let i = out.length - 1; i >= 0; i--) {
            const earlier = out[i];
            if (earlier.kind === "model_switch") {
              noted = earlier.quota?.model === model;
              break;
            }
            const earlierTurn = rowTurn(earlier);
            if (earlierTurn && tracesByTurn.get(earlierTurn.turnId)?.traceSummary?.model) break;
          }
          const built = builtSwitches.get(row);
          if (noted) {
            // No second notice for the same move.
          } else if (built && sameRow(built, notice)) out.push(built);
          else {
            builtSwitches.set(row, notice);
            out.push(notice);
          }
        }
        lastModelBySession.set(turn.sessionId, model);
      }
    }
    out.push(row);
  }
  return out;
}

/** A message that holds only a provider card drawn as nothing, beside its error. */
function isQuietFailure(message: ChatMessage): boolean {
  if (!message.content.includes('"provider_failure"')) return false;
  try {
    const parts = JSON.parse(message.content) as Array<Record<string, unknown>>;
    if (!Array.isArray(parts)) return false;
    let quiet = false;
    for (const part of parts) {
      if (part.type === "error") continue;
      if (part.type !== "provider_failure") return false;
      const resolved = part.resolved as { by?: string } | undefined;
      if (part.retrying !== true && resolved?.by !== "moved") return false;
      quiet = true;
    }
    return quiet;
  } catch {
    return false;
  }
}
