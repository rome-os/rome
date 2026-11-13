import type { ChatMessage, TranscriptPart } from "@/lib/chat-types";
import { orderChatMessages } from "@/lib/chat-message-ordering";
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
// chat instead of using the card is the natural "skip this" for a question or a
// provider sign-in, but not for an app's half-filled form.
//
// The connect-AI card has to be here as well as the question card: it resolves
// itself once a provider signs in, so an earlier copy left open would submit a
// second `{ connected: true }` and drive the script a step past where the
// guardian is.
const AUTO_DISMISSED_COMPONENT_IDS = new Set(["question-card", "ai-tools-card"]);

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

// (session, toolUseId) → the message holding that id's latest card. A tool id
// like `item_0` recurs across turns, so the key alone does not say which card
// a result answers; the message does.
function latestCardMessages(messages: ChatMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const b of parseMessageEntries(msg)) {
      if (b.type === "pending_interaction") {
        map.set(interactionResultKey(msg.sessionId, b.toolUseId), msg.id);
      }
    }
  }
  return map;
}

// (card message, session, toolUseId) → the result that card occurrence got,
// read in transcript order as buildInteractionResults reads it. Kept per
// occurrence, so a later card that reuses the tool id has its own.
function resultsByCard(messages: ChatMessage[]): Map<string, Record<string, unknown>> {
  const results = new Map<string, Record<string, unknown>>();
  const cardOf = new Map<string, string>();
  // Per session, the built-in cards still open, which a typed reply dismisses.
  const openCards = new Map<string, Set<string>>();
  const occurrence = (key: string) => `${cardOf.get(key)}\u0000${key}`;
  for (const msg of messages) {
    let userTextReply = false;
    for (const b of parseMessageEntries(msg)) {
      if (msg.role === "assistant" && b.type === "pending_interaction") {
        const key = interactionResultKey(msg.sessionId, b.toolUseId);
        cardOf.set(key, msg.id);
        const open = openCards.get(msg.sessionId) ?? new Set<string>();
        open.delete(key);
        if (isAutoDismissedCard(b)) open.add(key);
        openCards.set(msg.sessionId, open);
      } else if (msg.role === "user" && b.type === "interaction_result") {
        const key = interactionResultKey(msg.sessionId, b.toolUseId);
        if (cardOf.has(key)) results.set(occurrence(key), b.output);
        openCards.get(msg.sessionId)?.delete(key);
      } else if (msg.role === "user" && b.type === "text" && b.content.trim()) {
        userTextReply = true;
      }
    }
    const open = userTextReply ? openCards.get(msg.sessionId) : undefined;
    if (open) {
      for (const key of open) results.set(occurrence(key), { dismissed: true });
      open.clear();
    }
  }
  return results;
}

/**
 * The card results a chat thread's own transcript reads. They are read from
 * the thread's fetched messages and the main timeline's together, in order
 * and each message once: the thread's can lie well before the main
 * timeline's loaded page, and a typed reply placed in another thread, which
 * dismisses the card, is only in the main timeline's. Each card gets the
 * result of its own occurrence, so a later card that reuses the tool id
 * leaves it as it was. The main timeline's results, which also hold ones not
 * yet in any message, then apply to a card the thread shows as the same
 * message.
 */
export function threadInteractionResults(
  threadMessages: ChatMessage[],
  main: { messages: ChatMessage[]; results: ChatView["interactionResults"] },
): ChatView["interactionResults"] {
  const union = new Map<string, ChatMessage>();
  for (const msg of [...threadMessages, ...main.messages]) union.set(msg.id, msg);
  const byCard = resultsByCard(orderChatMessages([...union.values()]));
  const threadCards = latestCardMessages(threadMessages);
  const mainCards = latestCardMessages(main.messages);
  const results: ChatView["interactionResults"] = new Map();
  for (const [key, card] of threadCards) {
    const own = byCard.get(`${card}\u0000${key}`);
    if (own !== undefined) results.set(key, own);
  }
  for (const [key, output] of main.results) {
    const card = threadCards.get(key);
    if (card !== undefined && card === mainCards.get(key)) results.set(key, output);
  }
  return results;
}

export function buildChatView(
  messages: Map<string, ChatMessage[]>,
  mainSessionId: string,
  mainIdentity: AgentIdentity,
): ChatView {
  // Trace placement needs no reorder: rows are grouped by turn and a turn's
  // trace is looked up by id and shown as its subtitle, so its position in the
  // list doesn't matter.
  const displayMessages = orderChatMessages(messages.get(mainSessionId) ?? []);
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
  | (RowBase & { kind: "model_switch"; model: string; turnId: string; sessionId: string })
  // The chat's agent session was renewed before this turn, for `reason`.
  | (RowBase & {
      kind: "session_renewal";
      reason: string;
      renewedSessionId: string;
      turnId: string;
    });

// The rows the last build made, by the message each starts from. A build hands
// back the row object it made before when nothing the row shows has changed, so
// the memoized row views skip a render when a message arrives. Weak, so a
// message that leaves the transcript takes its row along.
const builtRows = new WeakMap<ChatMessage, ChatRow>();
// A model-switch notice is keyed by the row it stands before.
const builtSwitches = new WeakMap<ChatRow, ChatRow>();
// A session-renewal notice is keyed by the row it stands before.
const builtRenewals = new WeakMap<ChatRow, ChatRow>();

function sameIdentity(a: AgentIdentity, b: AgentIdentity): boolean {
  return a === b || (a.name === b.name && a.iconUrl === b.iconUrl);
}

function sameRow(a: ChatRow, b: ChatRow): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "user") return true;
  if (a.kind === "model_switch") {
    return b.kind === "model_switch" && a.model === b.model && a.turnId === b.turnId;
  }
  if (a.kind === "session_renewal") {
    return b.kind === "session_renewal" && a.reason === b.reason && a.turnId === b.turnId;
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
  for (const m of messages) {
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
    if (msg.role === "user") {
      rows.push(reuseRow(msg, { kind: "user", key: msg.id, message: msg }));
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
    // Group a whole turn under one header: gather this turn's assistant
    // messages, stepping over a same-turn trace (it's rendered once as the
    // turn's subtitle via tracesByTurn, so its position in the list is
    // irrelevant — grouping keys on turnId, not raw adjacency). A different
    // turn/session, or a user message, ends the turn.
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

/** The turn and session a row belongs to, or null for a row with no turn. */
function rowTurn(row: ChatRow): { turnId: string; sessionId: string } | null {
  if (row.kind === "model_switch" || row.kind === "session_renewal") return null;
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
  // A renewed session's first turn says so once, even when it ran again.
  const renewedSessions = new Set<string>();
  const out: ChatRow[] = [];
  for (const row of rows) {
    const turn = rowTurn(row);
    if (turn && !seenTurns.has(turn.turnId)) {
      seenTurns.add(turn.turnId);
      const renewal = tracesByTurn.get(turn.turnId)?.traceSummary?.sessionRenewal;
      if (renewal && !renewedSessions.has(renewal.sessionId)) {
        renewedSessions.add(renewal.sessionId);
        const notice: ChatRow = {
          kind: "session_renewal",
          key: `session-renewal:${renewal.sessionId}`,
          reason: renewal.reason,
          renewedSessionId: renewal.sessionId,
          turnId: turn.turnId,
        };
        const built = builtRenewals.get(row);
        if (built && sameRow(built, notice)) out.push(built);
        else {
          builtRenewals.set(row, notice);
          out.push(notice);
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
            turnId: turn.turnId,
            sessionId: turn.sessionId,
          };
          const built = builtSwitches.get(row);
          if (built && sameRow(built, notice)) out.push(built);
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
