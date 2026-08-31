import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import { buildChatView, buildRows, interactionResultKey, type AgentIdentity } from "./chat-view";

const MAIN = "M";
const CHILD = "C";
const MAIN_IDENTITY: AgentIdentity = { name: "Main", iconUrl: null };

let seq = 0;
function mk(
  sessionId: string,
  role: ChatMessage["role"],
  turnId: string,
  blocks: unknown[],
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: `m${seq++}`,
    sessionId,
    turnId,
    role,
    content: JSON.stringify(blocks),
    createdAt: new Date(0).toISOString(),
    ...extra,
  };
}

const handoffBlock = {
  type: "handoff",
  toolUseId: "h1",
  appId: "workflow-studio",
  agentName: "workflow-planner",
  childSessionId: CHILD,
  payload: { summary: "brief", agentLabel: "Workflow Planner" },
};

// Main: user → [handoff + narration in ONE turn]. Child: seed "brief" → reply.
function tree(resolved = false): Map<string, ChatMessage[]> {
  const main: ChatMessage[] = [
    mk(MAIN, "user", "t1", [{ type: "text", content: "do X" }]),
    mk(MAIN, "assistant", "t2", [handoffBlock]),
    mk(MAIN, "assistant", "t2", [{ type: "text", content: "narration" }]),
  ];
  if (resolved) {
    main.push(
      mk(MAIN, "user", "t3", [{ type: "interaction_result", toolUseId: "h1", output: { ok: 1 } }]),
    );
  }
  const child: ChatMessage[] = [
    mk(CHILD, "user", "c1", [{ type: "text", content: "brief" }]),
    mk(CHILD, "assistant", "c2", [{ type: "text", content: "specialist reply" }]),
  ];
  return new Map([
    [MAIN, main],
    [CHILD, child],
  ]);
}

describe("buildChatView", () => {
  it("merges the child after the handoff's whole turn and suppresses the seed", () => {
    const v = buildChatView(tree(), MAIN, MAIN_IDENTITY);
    // do X, handoff(turn t2), narration(turn t2), then child reply — seed gone.
    expect(v.displayMessages.map((m) => m.sessionId)).toEqual([MAIN, MAIN, MAIN, CHILD]);
    // The child's seed (its only user message) is suppressed — no CHILD user row.
    expect(v.displayMessages.filter((m) => m.role === "user" && m.sessionId === CHILD)).toEqual([]);
    expect(v.displayMessages.at(-1)?.content).toContain("specialist reply");
  });

  it("indexes the handoff and points the floor at its open child", () => {
    const v = buildChatView(tree(), MAIN, MAIN_IDENTITY);
    expect(v.handoffList).toHaveLength(1);
    expect(v.handoffList[0]).toMatchObject({
      toolUseId: "h1",
      parentSessionId: MAIN,
      childSessionId: CHILD,
      status: "open",
      agentLabel: "Workflow Planner",
    });
    expect(v.floorSessionId).toBe(CHILD);
    expect(v.identityBySession.get(CHILD)).toEqual({
      name: "Workflow Planner",
      iconUrl: "/api/apps/workflow-studio/icon",
    });
    expect(v.identityBySession.get(MAIN)).toBe(MAIN_IDENTITY);
  });

  it("returns the floor to main once the handoff resolves", () => {
    const v = buildChatView(tree(true), MAIN, MAIN_IDENTITY);
    expect(v.handoffList[0].status).toBe("done");
    expect(v.floorSessionId).toBe(MAIN);
    // Resolution is posted to the handoff's parent (main) session, namespaced.
    expect(v.interactionResults.get(interactionResultKey(MAIN, "h1"))).toEqual({ ok: 1 });
    expect(v.interactionResults.get("h1")).toBeUndefined(); // bare id no longer collides
  });

  const questionCard = (toolUseId: string) => ({
    type: "pending_interaction",
    toolUseId,
    appId: "core",
    render: {
      kind: "inline",
      componentId: "question-card",
      builtin: true,
      props: { questions: [] },
    },
  });

  it("auto-dismisses an open ask_question card when the guardian replies in chat", () => {
    const messages = new Map<string, ChatMessage[]>([
      [
        MAIN,
        [
          mk(MAIN, "user", "t1", [{ type: "text", content: "go" }]),
          mk(MAIN, "assistant", "t2", [questionCard("q_0")]),
          // Typed reply instead of using the card → auto-dismiss.
          mk(MAIN, "user", "t3", [{ type: "text", content: "actually do Y instead" }]),
        ],
      ],
    ]);
    const v = buildChatView(messages, MAIN, MAIN_IDENTITY);
    expect(v.interactionResults.get(interactionResultKey(MAIN, "q_0"))).toEqual({
      dismissed: true,
    });
  });

  it("keeps a real card answer over auto-dismiss, and leaves unanswered cards open", () => {
    const messages = new Map<string, ChatMessage[]>([
      [
        MAIN,
        [
          mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
          // Resolving the card is parts-only (no text block) → not a chat reply.
          mk(MAIN, "user", "t2", [
            {
              type: "interaction_result",
              toolUseId: "q_0",
              output: { answers: [{ questionId: "a", value: "x" }] },
            },
          ]),
          // A still-open card with no later typed reply stays interactive.
          mk(MAIN, "assistant", "t3", [questionCard("q_1")]),
        ],
      ],
    ]);
    const v = buildChatView(messages, MAIN, MAIN_IDENTITY);
    expect(v.interactionResults.get(interactionResultKey(MAIN, "q_0"))).toEqual({
      answers: [{ questionId: "a", value: "x" }],
    });
    expect(v.interactionResults.get(interactionResultKey(MAIN, "q_1"))).toBeUndefined();
  });

  it("does not collide a recycled toolUseId across merged sessions", () => {
    // Both sessions have an `item_0` interaction: main's is resolved, the
    // child's is still open. Bare-id keying would have let one mark the other.
    const messages = new Map<string, ChatMessage[]>([
      [
        MAIN,
        [
          mk(MAIN, "user", "t1", [{ type: "text", content: "go" }]),
          mk(MAIN, "assistant", "t2", [handoffBlock]),
          mk(MAIN, "assistant", "t2", [
            { type: "pending_interaction", toolUseId: "item_0", appId: "x", render: {} },
          ]),
          mk(MAIN, "user", "t3", [
            { type: "interaction_result", toolUseId: "item_0", output: { picked: "main" } },
          ]),
        ],
      ],
      [
        CHILD,
        [
          mk(CHILD, "user", "c1", [{ type: "text", content: "brief" }]),
          mk(CHILD, "assistant", "c2", [
            { type: "pending_interaction", toolUseId: "item_0", appId: "x", render: {} },
          ]),
        ],
      ],
    ]);
    const v = buildChatView(messages, MAIN, MAIN_IDENTITY);
    expect(v.interactionResults.get(interactionResultKey(MAIN, "item_0"))).toEqual({
      picked: "main",
    });
    // The child's same-id card is untouched — still open.
    expect(v.interactionResults.get(interactionResultKey(CHILD, "item_0"))).toBeUndefined();
  });
});

describe("buildRows", () => {
  it("groups same-turn assistant messages under one speaker row", () => {
    const v = buildChatView(tree(), MAIN, MAIN_IDENTITY);
    const rows = buildRows(v.displayMessages, v.identityBySession, MAIN_IDENTITY, {
      runningTurnId: null,
      isStreaming: false,
    });
    expect(rows.map((r) => r.kind)).toEqual(["user", "agent", "agent"]);
    const mainTurn = rows[1];
    // handoff + narration (same turn t2) collapse into one row of two messages.
    expect(mainTurn.kind === "agent" && mainTurn.messages).toHaveLength(2);
    expect(mainTurn.kind === "agent" && mainTurn.identity.name).toBe("Main");
    const childTurn = rows[2];
    expect(childTurn.kind === "agent" && childTurn.identity.name).toBe("Workflow Planner");
  });

  it("keeps a multi-assistant turn as one row regardless of where its trace sits", () => {
    const idMap = new Map([[MAIN, MAIN_IDENTITY]]);
    const summary = { distinctApps: [], totalSteps: 1, invocationCounts: {} };
    const trace = mk(MAIN, "trace", "t1", [], { traceSummary: summary });
    const a1 = mk(MAIN, "assistant", "t1", [{ type: "text", content: "one" }]);
    const a2 = mk(MAIN, "assistant", "t1", [{ type: "text", content: "two" }]);
    // trace before / between / after the two assistant replies of the same turn.
    for (const order of [
      [trace, a1, a2],
      [a1, trace, a2],
      [a1, a2, trace],
    ]) {
      const rows = buildRows(order, idMap, MAIN_IDENTITY, {
        runningTurnId: null,
        isStreaming: false,
      });
      const agentRows = rows.filter((r) => r.kind === "agent");
      expect(agentRows).toHaveLength(1); // one turn → one header, never split by the trace
      expect(agentRows[0].kind === "agent" && agentRows[0].messages).toHaveLength(2);
      expect(agentRows[0].kind === "agent" && agentRows[0].trace).toBe(trace); // trace as subtitle
    }
  });
});
