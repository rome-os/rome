import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "@/lib/chat-types";
import {
  buildChatView,
  buildRows,
  canPickChatModel,
  interactionResultKey,
  isAwaitingGuardian,
  isLockedByCard,
  isLastTurnFailed,
  type AgentIdentity,
} from "./chat-view";

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

  const aiToolsCard = (toolUseId: string) => ({
    type: "pending_interaction",
    toolUseId,
    appId: "core",
    render: { kind: "inline", componentId: "ai-tools-card", builtin: true, props: {} },
  });

  // The connect-AI card resolves itself once a provider signs in. Typing in the
  // composer re-shows it, so an earlier copy left open would submit a second
  // `{ connected: true }` and push the welcome script past the step the
  // guardian is on.
  it("auto-dismisses an open connect-AI card when the guardian replies in chat", () => {
    const messages = new Map<string, ChatMessage[]>([
      [
        MAIN,
        [
          mk(MAIN, "assistant", "t1", [aiToolsCard("c_0")]),
          mk(MAIN, "user", "t2", [{ type: "text", content: "what counts as connected?" }]),
          mk(MAIN, "assistant", "t3", [aiToolsCard("c_1")]),
        ],
      ],
    ]);
    const v = buildChatView(messages, MAIN, MAIN_IDENTITY);
    expect(v.interactionResults.get(interactionResultKey(MAIN, "c_0"))).toEqual({
      dismissed: true,
    });
    // The card the guardian is actually looking at stays interactive.
    expect(v.interactionResults.get(interactionResultKey(MAIN, "c_1"))).toBeUndefined();
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

describe("buildRows model switch notice", () => {
  const idMap = new Map([[MAIN, MAIN_IDENTITY]]);
  const turn = (sessionId: string, turnId: string, model?: string) => [
    mk(sessionId, "user", turnId, [{ type: "text", content: `ask ${turnId}` }]),
    mk(sessionId, "trace", turnId, [], {
      traceSummary: {
        distinctApps: [],
        totalSteps: 0,
        invocationCounts: {},
        ...(model ? { model } : {}),
      },
    }),
    mk(sessionId, "assistant", turnId, [{ type: "text", content: `reply ${turnId}` }]),
  ];
  const rowsOf = (messages: ChatMessage[], runningTurnId: string | null = null) =>
    buildRows(messages, idMap, MAIN_IDENTITY, { runningTurnId, isStreaming: !!runningTurnId });

  it("puts a notice before the first turn that ran on another model", () => {
    const rows = rowsOf([
      ...turn(MAIN, "t1", "claude-sonnet-5-5"),
      ...turn(MAIN, "t2", "claude-sonnet-5-5"),
      ...turn(MAIN, "t3", "gpt-6-luna"),
      ...turn(MAIN, "t4", "gpt-6-luna"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      "user",
      "agent",
      "user",
      "agent",
      "model_switch",
      "user",
      "agent",
      "user",
      "agent",
    ]);
    expect(rows[4]).toMatchObject({ kind: "model_switch", model: "gpt-6-luna", turnId: "t3" });
  });

  it("skips turns with no known model and compares within one session", () => {
    const rows = rowsOf([
      ...turn(MAIN, "t1", "gpt-6-luna"),
      ...turn(MAIN, "t2"),
      ...turn(CHILD, "c1", "claude-sonnet-5-5"),
      ...turn(MAIN, "t3", "gpt-6-luna"),
    ]);
    expect(rows.some((r) => r.kind === "model_switch")).toBe(false);
  });

  it("shows no notice for the first turn or the running turn", () => {
    const messages = [...turn(MAIN, "t1", "claude-sonnet-5-5"), ...turn(MAIN, "t2")];
    expect(rowsOf(messages, "t2").some((r) => r.kind === "model_switch")).toBe(false);
  });
});

describe("canPickChatModel", () => {
  it("shows the picker in an open chat with no handoff", () => {
    expect(canPickChatModel({ mainSessionId: MAIN, floorSessionId: MAIN, isSideChat: false })).toBe(
      true,
    );
  });

  it("hides it during an open handoff and in a promoted side chat", () => {
    expect(
      canPickChatModel({ mainSessionId: MAIN, floorSessionId: CHILD, isSideChat: false }),
    ).toBe(false);
    expect(canPickChatModel({ mainSessionId: MAIN, floorSessionId: MAIN, isSideChat: true })).toBe(
      false,
    );
  });
});

describe("isLastTurnFailed", () => {
  const trace = (sessionId: string, turnId: string, turnStatus?: "completed" | "error") =>
    mk(sessionId, "trace", turnId, [], {
      traceSummary: { distinctApps: [], totalSteps: 1, invocationCounts: {}, turnStatus },
    });
  const failed = (main: ChatMessage[]) =>
    isLastTurnFailed(buildChatView(new Map([[MAIN, main]]), MAIN, MAIN_IDENTITY));

  it("reads the floor's latest turn end", () => {
    expect(failed([trace(MAIN, "t1", "error")])).toBe(true);
    expect(failed([trace(MAIN, "t1", "error"), trace(MAIN, "t2", "completed")])).toBe(false);
    expect(failed([trace(MAIN, "t1", "completed"), trace(MAIN, "t2", "error")])).toBe(true);
    expect(failed([])).toBe(false);
  });
});

describe("isAwaitingGuardian", () => {
  const questionCard = (toolUseId: string) => ({
    type: "pending_interaction",
    toolUseId,
    appId: "core",
    render: { kind: "inline", componentId: "question-card", builtin: true, props: {} },
  });
  const appForm = (toolUseId: string) => ({
    type: "pending_interaction",
    toolUseId,
    appId: "survey",
    render: { kind: "inline", componentId: "form", props: {} },
  });
  const awaiting = (main: ChatMessage[], child?: ChatMessage[], runningTurnId?: string) => {
    const messages = new Map<string, ChatMessage[]>([[MAIN, main]]);
    if (child) messages.set(CHILD, child);
    return isAwaitingGuardian(buildChatView(messages, MAIN, MAIN_IDENTITY), runningTurnId);
  };

  it("is true while the last message is an unanswered card", () => {
    expect(
      awaiting([
        mk(MAIN, "user", "t1", [{ type: "text", content: "plan a trip" }]),
        mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
      ]),
    ).toBe(true);
  });

  it("is true when the turn's closing text follows the card", () => {
    expect(
      awaiting([
        mk(MAIN, "user", "t1", [{ type: "text", content: "plan a trip" }]),
        mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        mk(MAIN, "assistant", "t1", [{ type: "text", content: "Choose the dates above." }], {
          turnPhase: "final",
        }),
      ]),
    ).toBe(true);
  });

  it("is false once a backend-initiated turn follows the card", () => {
    expect(
      awaiting([
        mk(MAIN, "user", "t1", [{ type: "text", content: "plan a trip" }]),
        mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        mk(MAIN, "assistant", "backend:b1", [{ type: "text", content: "Approved. Booking now." }]),
      ]),
    ).toBe(false);
  });

  it("is false while a newer turn runs that has saved nothing yet", () => {
    expect(
      awaiting(
        [
          mk(MAIN, "user", "t1", [{ type: "text", content: "plan a trip" }]),
          mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        ],
        undefined,
        "backend:b1",
      ),
    ).toBe(false);
  });

  it("is true while the running turn itself is parked on the card", () => {
    expect(
      awaiting(
        [
          mk(MAIN, "user", "t1", [{ type: "text", content: "plan a trip" }]),
          mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        ],
        undefined,
        "t1",
      ),
    ).toBe(true);
  });

  it("is true when the turn's recap follows the card", () => {
    expect(
      awaiting([
        mk(MAIN, "user", "t1", [{ type: "text", content: "plan a trip" }]),
        mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        mk(MAIN, "assistant", "t1", [
          { type: "turn_recap", turnId: "t1", content: "Asked for dates." },
        ]),
      ]),
    ).toBe(true);
  });

  it("is false once the card is answered", () => {
    expect(
      awaiting([
        mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        mk(MAIN, "user", "t2", [{ type: "interaction_result", toolUseId: "q_0", output: {} }]),
      ]),
    ).toBe(false);
  });

  it("is false once the guardian replies in chat instead", () => {
    expect(
      awaiting([
        mk(MAIN, "assistant", "t1", [questionCard("q_0")]),
        mk(MAIN, "user", "t2", [{ type: "text", content: "never mind" }]),
      ]),
    ).toBe(false);
  });

  it("ignores an app form left open further up the transcript", () => {
    expect(
      awaiting([
        mk(MAIN, "assistant", "t1", [appForm("f_0")]),
        mk(MAIN, "user", "t2", [{ type: "text", content: "skip the form" }]),
        mk(MAIN, "assistant", "t2", [{ type: "text", content: "Okay." }]),
      ]),
    ).toBe(false);
  });

  it("reads the floor session while a handoff is open", () => {
    expect(
      awaiting(
        [mk(MAIN, "assistant", "t1", [handoffBlock])],
        [mk(CHILD, "assistant", "c1", [questionCard("q_0")])],
      ),
    ).toBe(true);
  });
});

describe("isLockedByCard", () => {
  const card = (toolUseId: string, requiresCard?: boolean) => ({
    type: "pending_interaction",
    toolUseId,
    appId: "welcome-to-rome",
    render: {
      kind: "inline",
      componentId: "name-card",
      props: {},
      ...(requiresCard === undefined ? {} : { requiresCard }),
    },
  });
  const locked = (main: ChatMessage[], runningTurnId?: string) =>
    isLockedByCard(buildChatView(new Map([[MAIN, main]]), MAIN, MAIN_IDENTITY), runningTurnId);

  it("is true while a card that is the only way to answer waits", () => {
    expect(
      locked([
        mk(MAIN, "user", "t1", [{ type: "text", content: "hi" }]),
        mk(MAIN, "assistant", "t1", [card("c_0", true)]),
      ]),
    ).toBe(true);
  });

  it("is false for a card typed text may replace", () => {
    expect(
      locked([
        mk(MAIN, "user", "t1", [{ type: "text", content: "hi" }]),
        mk(MAIN, "assistant", "t1", [card("c_0")]),
      ]),
    ).toBe(false);
    expect(
      locked([
        mk(MAIN, "user", "t1", [{ type: "text", content: "hi" }]),
        mk(MAIN, "assistant", "t1", [card("c_0", false)]),
      ]),
    ).toBe(false);
  });

  it("is false once the card is answered", () => {
    expect(
      locked([
        mk(MAIN, "assistant", "t1", [card("c_0", true)]),
        mk(MAIN, "user", "t2", [{ type: "interaction_result", toolUseId: "c_0", output: {} }]),
      ]),
    ).toBe(false);
  });

  it("is false while a newer turn runs that has saved nothing yet", () => {
    expect(
      locked(
        [
          mk(MAIN, "user", "t1", [{ type: "text", content: "hi" }]),
          mk(MAIN, "assistant", "t1", [card("c_0", true)]),
        ],
        "backend:b1",
      ),
    ).toBe(false);
  });
});
