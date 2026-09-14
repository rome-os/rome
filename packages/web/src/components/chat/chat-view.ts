import type { ChatMessage, StreamBlock } from "@/lib/chat-types";
import { orderChatMessages } from "@/lib/chat-message-ordering";
import { prettyAgentName } from "@/lib/agent-name";
import { parseMessageBlocks } from "@/components/chat/blocks/parse-blocks";

// Pure derivation: many flat per-session message lists → one renderable view.
// This is the single place the multi-session handoff tree is merged. No React,
// no fetch — fully unit-testable.

export interface AgentIdentity {
  name: string;
  iconUrl: string | null;
}

// One handoff seam located in some session's transcript: the assistant `handoff`
// block that opened it, the `interaction_result` (in the SAME parent session)
// that closed it (open while absent), and the child session the specialist's
// conversation lives in. Handoffs nest — a child can hold its own.
export interface HandoffNode {
  toolUseId: string;
  appId: string;
  agentName?: string;
  agentLabel: string;
  summary?: string;
  // The session whose transcript contains this handoff block — where its
  // resolution is posted. Not always the main session.
  parentSessionId: string;
  childSessionId: string;
  // "cancelled" = resolved by dismissing (no handback), distinct from "done".
  status: "open" | "done" | "cancelled";
}

export interface ChatView {
  // Flat, ordered, child-spliced transcript across the whole session tree.
  displayMessages: ChatMessage[];
  // Every handoff reachable from the main session (recursive).
  handoffList: HandoffNode[];
  // The session the single composer currently talks to (deepest open handoff's
  // child, else main).
  floorSessionId: string;
  // sessionId → avatar + name for the group-chat rows.
  identityBySession: Map<string, AgentIdentity>;
  // childSessionId → its seed brief (suppressed in the transcript, shown as the
  // caller's @mention instead).
  seedByChild: Map<string, string>;
  // toolUseId → resolved interaction output (for inline cards + seam status).
  interactionResults: Map<string, Record<string, unknown>>;
}

// Exported for the timeline rail, which labels its dots with the same plain
// text the transcript renders in the bubble.
export function userMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return content;
    return parsed
      .filter((b) => b?.type === "text" && typeof b.content === "string")
      .map((b) => b.content as string)
      .join("\n");
  } catch {
    return content;
  }
}

// Index every handoff reachable from `sessionId`, recursing into child sessions.
// Status is derived by pairing each handoff with its interaction_result within
// the same (parent) session — an ordered pass handles toolUseId recycling.
function indexHandoffs(
  sessionId: string,
  messagesBySession: Map<string, ChatMessage[]>,
  out: HandoffNode[] = [],
): HandoffNode[] {
  const msgs = messagesBySession.get(sessionId) ?? [];
  const openByToolUseId = new Map<string, HandoffNode>();
  for (const msg of msgs) {
    for (const b of parseMessageBlocks(msg)) {
      if (msg.role === "user") {
        if (b.type === "interaction_result" && b.toolUseId) {
          const node = openByToolUseId.get(b.toolUseId);
          if (node) {
            node.status =
              b.output &&
              typeof b.output === "object" &&
              (b.output as Record<string, unknown>).dismissed === true
                ? "cancelled"
                : "done";
            openByToolUseId.delete(b.toolUseId);
          }
        }
        continue;
      }
      if (msg.role !== "assistant" || b.type !== "handoff") continue;
      if (!b.toolUseId || !b.appId || !b.childSessionId) continue;
      const node: HandoffNode = {
        toolUseId: b.toolUseId,
        appId: b.appId,
        agentName: b.agentName,
        agentLabel:
          (typeof b.payload?.agentLabel === "string" && b.payload.agentLabel) ||
          prettyAgentName(b.agentName ?? b.appId),
        summary: typeof b.payload?.summary === "string" ? b.payload.summary : undefined,
        parentSessionId: sessionId,
        childSessionId: b.childSessionId,
        status: "open",
      };
      out.push(node);
      openByToolUseId.set(b.toolUseId, node);
      indexHandoffs(b.childSessionId, messagesBySession, out);
    }
  }
  return out;
}

// Walk from the main session down the chain of OPEN handoffs to the deepest
// open child — the session the single composer currently talks to.
function findFloorSession(sessionId: string, handoffsByParent: Map<string, HandoffNode[]>): string {
  const open = (handoffsByParent.get(sessionId) ?? []).find((h) => h.status === "open");
  return open ? findFloorSession(open.childSessionId, handoffsByParent) : sessionId;
}

// Flatten the whole session tree into one transcript: a session's messages in
// order, and after each handoff the child session's messages spliced in
// (recursively). The child is spliced after the ENTIRE turn that contains the
// handoff — not immediately after the handoff message — so the calling agent's
// turn (its @mention plus any narration it sent in the same turn) stays one
// contiguous speaker block. A child session's seed (the opening brief) is shown
// as the caller's @mention instead, so it's suppressed — matched by text so a
// real first reply is never hidden when a handoff carried no brief.
function buildDisplayMessages(
  sessionId: string,
  messagesBySession: Map<string, ChatMessage[]>,
  seedByChild: Map<string, string>,
): ChatMessage[] {
  const msgs = messagesBySession.get(sessionId) ?? [];
  const seedText = seedByChild.get(sessionId);
  const out: ChatMessage[] = [];
  let checkedFirstUser = false;
  let pendingChildren: string[] = [];
  let currentTurn: string | null | undefined;
  const flushChildren = () => {
    for (const childSid of pendingChildren) {
      out.push(...buildDisplayMessages(childSid, messagesBySession, seedByChild));
    }
    pendingChildren = [];
  };
  for (const msg of msgs) {
    if (msg.turnId !== currentTurn) {
      flushChildren();
      currentTurn = msg.turnId;
    }
    if (!checkedFirstUser && msg.role === "user") {
      checkedFirstUser = true;
      if (seedText && userMessageText(msg.content).trim() === seedText.trim()) continue;
    }
    out.push(msg);
    for (const b of parseMessageBlocks(msg)) {
      if (b.type === "handoff" && b.childSessionId) pendingChildren.push(b.childSessionId);
    }
  }
  flushChildren();
  return out;
}

// Key resolved-interaction state by (session, toolUseId). Provider toolUseIds
// like `item_0` recur every turn AND across sessions, so the merged transcript
// must namespace them per session or one session's resolved card would mark a
// same-id card in another session resolved.
export function interactionResultKey(sessionId: string, toolUseId: string): string {
  return `${sessionId}:${toolUseId}`;
}

// The host's own built-in cards (vs an app's inline component or a handoff):
// the only suspensions auto-dismissed by a free-text reply, since typing in
// chat instead of using the card is the natural "skip this" for a question or a
// provider sign-in, but not for an app's half-filled form.
//
// The connect-AI card has to be here as well as the question card: it resolves
// itself once a provider signs in, so an earlier copy left open would submit a
// second `{ connected: true }` and drive the script a step past where the
// guardian is.
const AUTO_DISMISSED_COMPONENT_IDS = new Set(["question-card", "ai-tools-card"]);

function isAutoDismissedCard(b: StreamBlock): boolean {
  return (
    b.type === "pending_interaction" &&
    b.render?.builtin === true &&
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
    for (const b of parseMessageBlocks(msg)) {
      if (
        msg.role === "assistant" &&
        (b.type === "pending_interaction" || b.type === "handoff") &&
        b.toolUseId
      ) {
        map.delete(interactionResultKey(msg.sessionId, b.toolUseId));
        if (isAutoDismissedCard(b)) {
          const open = openCards.get(msg.sessionId) ?? new Set<string>();
          open.add(b.toolUseId);
          openCards.set(msg.sessionId, open);
        }
      } else if (
        msg.role === "user" &&
        b.type === "interaction_result" &&
        b.toolUseId &&
        b.output &&
        typeof b.output === "object"
      ) {
        map.set(
          interactionResultKey(msg.sessionId, b.toolUseId),
          b.output as Record<string, unknown>,
        );
        openCards.get(msg.sessionId)?.delete(b.toolUseId);
      } else if (msg.role === "user" && b.type === "text" && (b.content ?? "").trim()) {
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
  const messagesBySession = new Map<string, ChatMessage[]>();
  // Trace placement no longer needs a reorder: rows are grouped by turn and a
  // turn's trace is looked up by id and shown as its subtitle, so its position
  // in the list doesn't matter.
  for (const [sid, raw] of messages) messagesBySession.set(sid, orderChatMessages(raw));

  const handoffList = indexHandoffs(mainSessionId, messagesBySession);

  const handoffsByParent = new Map<string, HandoffNode[]>();
  const seedByChild = new Map<string, string>();
  const identityBySession = new Map<string, AgentIdentity>([[mainSessionId, mainIdentity]]);
  for (const h of handoffList) {
    const arr = handoffsByParent.get(h.parentSessionId) ?? [];
    arr.push(h);
    handoffsByParent.set(h.parentSessionId, arr);
    if (h.summary) seedByChild.set(h.childSessionId, h.summary);
    identityBySession.set(h.childSessionId, {
      name: h.agentLabel,
      iconUrl: `/api/apps/${encodeURIComponent(h.appId)}/icon`,
    });
  }

  const floorSessionId = findFloorSession(mainSessionId, handoffsByParent);
  const displayMessages = buildDisplayMessages(mainSessionId, messagesBySession, seedByChild);
  const interactionResults = buildInteractionResults(displayMessages);

  return {
    displayMessages,
    handoffList,
    floorSessionId,
    identityBySession,
    seedByChild,
    interactionResults,
  };
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
  // assistant message in the turn. (A handoff seam is just a `handoff` block in
  // here — the seam's own backdrop is the block's, not the row's.)
  | (RowBase & {
      kind: "agent";
      identity: AgentIdentity;
      trace: ChatMessage | null;
      messages: ChatMessage[];
    });

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
    if (m.role === "trace" && m.turnId && m.traceSummary) tracesByTurn.set(m.turnId, m);
    if (m.role === "assistant" && m.turnId) turnsWithAssistant.add(m.turnId);
  }
  const isRunningTurn = (turnId: string | null | undefined) =>
    opts.isStreaming && opts.runningTurnId != null && turnId === opts.runningTurnId;

  const rows: ChatRow[] = [];
  const renderedTraceTurns = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      rows.push({ kind: "user", key: msg.id, message: msg });
      continue;
    }
    if (msg.role === "trace") {
      if (!msg.traceSummary) continue;
      // Merged into the turn's grouped row when it has assistant replies; only
      // stands alone for a reply-less turn. Never mid-stream for the running
      // turn (the live trace button carries it).
      if (msg.turnId && turnsWithAssistant.has(msg.turnId)) continue;
      if (isRunningTurn(msg.turnId)) continue;
      rows.push({ kind: "trace", key: msg.id, message: msg, identity: identityOf(msg.sessionId) });
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
    rows.push({
      kind: "agent",
      key: msg.id,
      identity: identityOf(msg.sessionId),
      trace: showTrace ? turnTrace! : null,
      messages: group,
    });
  }
  return rows;
}
