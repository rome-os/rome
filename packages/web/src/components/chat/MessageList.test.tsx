// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

// RomeLogo (the avatar fallback) renders an SVG mask that jsdom can't construct;
// stub it so the transcript renders. Same approach as ChatComponent.test.tsx.
rs.mock("@/components/logo", () => ({
  RomeLogo: (props: Record<string, unknown>) => <div data-testid="rome-logo" {...props} />,
}));
rs.mock("@/components/chat/TurnBranchButton", () => ({
  TurnBranchButton: () => <button type="button">side-chat-branch</button>,
}));
rs.mock("@/components/chat/TurnFeedbackButtons", () => ({
  TurnFeedbackButtons: () => null,
}));
import {
  findActiveSubmission,
  findLastSubmission,
  hasPendingApprovalConfirmation,
  MessageList,
  type BlockActions,
  type LivePreview,
  type ShareSelection,
} from "./MessageList";
import { buildRows, type AgentIdentity } from "./chat-view";
import type { ChatMessage } from "@/lib/chat-types";
import { ThemeProvider } from "@/hooks/use-theme";

afterEach(() => cleanup());

let seq = 0;
function assistantSubmission(name: string): ChatMessage {
  seq += 1;
  return {
    id: `a-${seq}`,
    sessionId: "s-1",
    role: "assistant",
    content: JSON.stringify([{ type: "submission_card", payload: { name } }]),
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

function humanReply(text: string): ChatMessage {
  seq += 1;
  return {
    id: `u-${seq}`,
    sessionId: "s-1",
    role: "user",
    content: text,
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

// The marker the host snapshots when the borrowed agent relays a verbal "yes"
// via confirm_output.
function handbackApproved(): ChatMessage {
  seq += 1;
  return {
    id: `a-${seq}`,
    sessionId: "s-1",
    role: "assistant",
    content: JSON.stringify([{ type: "handback_approved" }]),
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

// The approval-resolution turn the host posts when Approve is clicked: an
// interaction_result with no text the human typed.
function approvalResolution(): ChatMessage {
  seq += 1;
  return {
    id: `u-${seq}`,
    sessionId: "s-1",
    role: "user",
    content: JSON.stringify([
      { type: "interaction_result", toolUseId: "t-1", output: { approved: true } },
    ]),
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

// findActiveSubmission is what gates the composer's Approve button: it returns
// the submission the guardian can currently approve, or null when there is none
// (so the button stays hidden).
describe("findActiveSubmission", () => {
  it("returns the submission while the agent has submitted and no reply followed", () => {
    const active = findActiveSubmission([assistantSubmission("Morning digest")]);
    expect(active?.payload).toEqual({ name: "Morning digest" });
  });

  it("returns null once the human replies asking for changes", () => {
    const active = findActiveSubmission([
      assistantSubmission("Morning digest"),
      humanReply("send it to Slack, not email"),
    ]);
    expect(active).toBeNull();
  });

  it("returns the newest submission after a re-submission", () => {
    const active = findActiveSubmission([
      assistantSubmission("First draft"),
      humanReply("send it to Slack, not email"),
      assistantSubmission("Second draft"),
    ]);
    expect(active?.payload).toEqual({ name: "Second draft" });
  });

  it("returns null when there is no submission at all", () => {
    expect(findActiveSubmission([humanReply("hi")])).toBeNull();
  });

  it("stays active through an interaction_result that carries no human text", () => {
    // The resolution turn (interaction_result only) must not be mistaken for a
    // change request — otherwise it would suppress the very submission it
    // resolves while approval is still in flight.
    const active = findActiveSubmission([
      assistantSubmission("Morning digest"),
      approvalResolution(),
    ]);
    expect(active?.payload).toEqual({ name: "Morning digest" });
  });
});

// The verbal-approval gate: a `handback_approved` marker ships the standing
// submission (findLastSubmission), which the guardian's "yes" reply had
// superseded for the button — so we deliberately ignore supersede here.
describe("verbal approval (confirm_output) gate", () => {
  it("ships the standing submission even though the guardian's 'yes' superseded it for the button", () => {
    const messages = [
      assistantSubmission("Morning digest"),
      humanReply("yes, ship it"),
      handbackApproved(),
    ];
    // The button is gone (reply superseded it)...
    expect(findActiveSubmission(messages)).toBeNull();
    // ...but the confirmation pins the last submission for resolution.
    expect(hasPendingApprovalConfirmation(messages)).toBe(true);
    expect(findLastSubmission(messages)).toEqual({ name: "Morning digest" });
  });

  it("does not fire when the agent went back to refining after the marker", () => {
    // A fresh submission after a (stale) confirmation means the agent is
    // presenting a new candidate, not shipping — the marker must not resolve.
    const messages = [
      assistantSubmission("First"),
      handbackApproved(),
      humanReply("actually change the time"),
      assistantSubmission("Second"),
    ];
    expect(hasPendingApprovalConfirmation(messages)).toBe(false);
  });

  it("is inert with no submission to confirm", () => {
    expect(hasPendingApprovalConfirmation([handbackApproved()])).toBe(true);
    expect(findLastSubmission([handbackApproved()])).toBeNull();
  });
});

// A running turn whose row carries an inline question card. The card lives in the
// transcript row from the moment it persists, so the streaming→settled flip is a
// re-render of that row, not a remount — its mid-stream input must survive.
const IDENTITY: AgentIdentity = { name: "Rome", iconUrl: null };

function questionCardTurn(): ChatMessage {
  return {
    id: "a-card",
    sessionId: "s-1",
    role: "assistant",
    turnId: "turn-1",
    content: JSON.stringify([
      {
        type: "pending_interaction",
        toolUseId: "t-1",
        appId: "system",
        render: {
          builtin: true,
          componentId: "question-card",
          props: { questions: [{ id: "q1", question: "Your name?", type: "text" }] },
        },
      },
    ]),
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

function renderList(streaming: boolean) {
  const messages = [questionCardTurn()];
  const rows = buildRows(messages, new Map([["s-1", IDENTITY]]), IDENTITY, {
    runningTurnId: "turn-1",
    isStreaming: streaming,
  });
  const live: LivePreview = {
    isStreaming: streaming,
    runningTurnId: "turn-1",
    snapshot: null,
    text: "",
    identity: IDENTITY,
  };
  const actions: BlockActions = {
    onApprovalResolved: () => {},
    onSubmitAppComponent: () => {},
    onDismissAppComponent: () => {},
    interactionResults: new Map(),
  };
  return {
    rows,
    live,
    actions,
    element: (
      <MessageList
        rows={rows}
        live={live}
        contentRef={() => {}}
        onOpenLiveTrace={() => {}}
        onOpenStoredTrace={() => {}}
        actions={actions}
      />
    ),
  };
}

describe("MessageList inline-card state across streaming→settled", () => {
  it("keeps an inline question card's typed input when the turn finalizes", () => {
    const streamingView = renderList(true);
    const { rerender } = render(streamingView.element);

    // Type into the card mid-stream.
    const input = screen.getByPlaceholderText("Type your answer…") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Alice" } });
    expect(input.value).toBe("Alice");

    // The turn finalizes: same row (stable id) now renders settled. A remount
    // would reset the card's local draft to empty; an in-place re-render keeps it.
    rerender(renderList(false).element);
    expect((screen.getByPlaceholderText("Type your answer…") as HTMLTextAreaElement).value).toBe(
      "Alice",
    );
  });
});

describe("MessageList side-chat eligibility", () => {
  const renderSettledTurn = (turnStatus?: "completed" | "interrupted" | "error") => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-side-chat",
        sessionId: "s-1",
        turnId: "turn-side-chat",
        role: "assistant",
        content: JSON.stringify([{ type: "text", content: "Turn output" }]),
        createdAt: "2026-06-13T00:00:00.000Z",
      },
      {
        id: "trace-side-chat",
        sessionId: "s-1",
        turnId: "turn-side-chat",
        role: "trace",
        content: "[]",
        createdAt: "2026-06-13T00:00:01.000Z",
        traceSummary: {
          distinctApps: [],
          totalSteps: 0,
          invocationCounts: {},
          turnStatus,
        },
      },
    ];
    const rows = buildRows(messages, new Map([["s-1", IDENTITY]]), IDENTITY, {
      runningTurnId: null,
      isStreaming: false,
    });
    render(
      <ThemeProvider>
        <MessageList
          rows={rows}
          live={{
            isStreaming: false,
            runningTurnId: null,
            snapshot: null,
            text: "",
            identity: IDENTITY,
          }}
          contentRef={() => {}}
          onOpenLiveTrace={() => {}}
          onOpenStoredTrace={() => {}}
          actions={{
            onApprovalResolved: () => {},
            onSubmitAppComponent: () => {},
            onDismissAppComponent: () => {},
            interactionResults: new Map(),
          }}
          feedback
        />
      </ThemeProvider>,
    );
  };

  it("shows Side Chat only for completed turns", () => {
    renderSettledTurn("completed");
    expect(screen.getByRole("button", { name: "side-chat-branch" })).toBeTruthy();
  });

  it.each([
    "interrupted",
    "error",
    undefined,
  ] as const)("hides Side Chat when turn status is %s", (status) => {
    renderSettledTurn(status);
    expect(screen.queryByRole("button", { name: "side-chat-branch" })).toBeNull();
  });
});

function commentary(text: string, id = "a-text", blockIx: number | null = 0): ChatMessage {
  return {
    id,
    sessionId: "s-1",
    turnId: "turn-1",
    role: "assistant",
    content: JSON.stringify([
      {
        type: "text",
        content: text,
        turnPhase: "commentary",
        ...(blockIx !== null ? { blockIx } : {}),
      },
    ]),
    createdAt: "2026-06-13T00:00:01.000Z",
  };
}

function streamingList(messages: ChatMessage[], text: string, blockIx = 0, sourceText = text) {
  const { live, actions } = renderList(true);
  return (
    <ThemeProvider>
      <MessageList
        rows={buildRows(messages, new Map([["s-1", IDENTITY]]), IDENTITY, {
          runningTurnId: live.runningTurnId,
          isStreaming: true,
        })}
        live={{ ...live, text, blockIx, sourceText }}
        contentRef={() => {}}
        onOpenLiveTrace={() => {}}
        onOpenStoredTrace={() => {}}
        actions={actions}
      />
    </ThemeProvider>
  );
}

function expectBefore(earlier: HTMLElement, later: HTMLElement) {
  expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

describe("MessageList streaming input", () => {
  it("does not repeat persisted commentary after a follow-up input", () => {
    const original = commentary("I am checking the implementation.");
    const followup = humanReply("Please include pseudocode.");
    const { rerender } = render(streamingList([original], "I am checking the implementation."));

    rerender(streamingList([original, followup], "I am checking the implementation."));

    expect(screen.getAllByText("I am checking the implementation.")).toHaveLength(1);
    expectBefore(screen.getByLabelText("Working"), screen.getByText("Please include pseudocode."));
  });

  it("keeps a live block in its row when follow-up inputs arrive", () => {
    const original = commentary("The first step is complete.");
    const followup = humanReply("Please include pseudocode.");
    const another = humanReply("Use TypeScript.");
    const { rerender } = render(streamingList([original], "Now checking", 1));
    const liveText = screen.getByText("Now checking");

    rerender(streamingList([original, followup, another], "Now checking the next step.", 1));

    expect(screen.getByText("Now checking the next step.")).toBe(liveText);
    expectBefore(liveText, screen.getByText("Please include pseudocode."));
    expectBefore(liveText, screen.getByText("Use TypeScript."));
  });

  it("keeps the first unpersisted block before a follow-up input", () => {
    const initial = humanReply("Explain the implementation.");
    const followup = humanReply("Please include pseudocode.");
    const { rerender } = render(streamingList([initial], "I am checking"));
    const liveText = screen.getByText("I am checking");

    rerender(streamingList([initial, followup], "I am checking the implementation."));

    expect(screen.getByText("I am checking the implementation.")).toBe(liveText);
    expectBefore(liveText, screen.getByText("Please include pseudocode."));
  });

  it("places the next block after the follow-up without replaying the previous block", () => {
    const original = commentary("The first step is complete.");
    const followup = humanReply("Please include pseudocode.");
    const { rerender } = render(streamingList([original], "The first step is complete."));
    rerender(streamingList([original, followup], "The first step is complete."));

    rerender(streamingList([original, followup], "Here is the pseudocode.", 1));

    expect(screen.getAllByText("The first step is complete.")).toHaveLength(1);
    expectBefore(
      screen.getByText("Please include pseudocode."),
      screen.getByText("Here is the pseudocode."),
    );
  });

  it("deduplicates a replayed block when the last row is a follow-up input", () => {
    render(
      streamingList(
        [commentary("I am checking the implementation."), humanReply("Please include pseudocode.")],
        "I am checking the implementation.",
      ),
    );

    expect(screen.getAllByText("I am checking the implementation.")).toHaveLength(1);
    expectBefore(screen.getByLabelText("Working"), screen.getByText("Please include pseudocode."));
  });

  it("uses the source text to suppress a persisted block while typing catches up", () => {
    render(
      streamingList(
        [commentary("I am checking the implementation."), humanReply("Please include pseudocode.")],
        "I am checking",
        0,
        "I am checking the implementation.",
      ),
    );

    expect(screen.queryByText("I am checking", { exact: true })).toBeNull();
    expect(screen.getAllByText("I am checking the implementation.")).toHaveLength(1);
  });

  it("does not mistake a new block with identical text for an old persisted block", () => {
    const original = commentary("Checking the implementation.");
    const followup = humanReply("Check once more.");
    const { rerender } = render(
      streamingList([original, followup], "Checking the implementation.", 0),
    );

    rerender(streamingList([original, followup], "Checking the implementation.", 1));

    const copies = screen.getAllByText("Checking the implementation.");
    expect(copies).toHaveLength(2);
    expectBefore(screen.getByText("Check once more."), copies[1]);
  });

  it("renders legacy commentary without blockIx without matching it to a live block", () => {
    render(
      streamingList(
        [commentary("Historical commentary.", "legacy", null), humanReply("Continue from here.")],
        "Current live block.",
        0,
      ),
    );

    expect(screen.getByText("Historical commentary.")).toBeTruthy();
    expect(screen.getByText("Current live block.")).toBeTruthy();
  });

  it("does not move the previous typewriter frame below the follow-up at a block boundary", () => {
    const original = commentary("The first step is complete.");
    const followup = humanReply("Please include pseudocode.");
    const { rerender } = render(streamingList([original], "The first step is complete."));

    rerender(
      streamingList(
        [original, followup],
        "The first step is complete.",
        1,
        "Here is the pseudocode.",
      ),
    );

    expect(screen.getAllByText("The first step is complete.")).toHaveLength(1);
    expectBefore(screen.getByText("Please include pseudocode."), screen.getByLabelText("Working"));
  });
});

describe("MessageList Plan placement", () => {
  it("groups a collapsed completed Plan and collapsed Recap after turn text", () => {
    const messages: ChatMessage[] = [
      {
        id: "a-plan-1",
        sessionId: "s-1",
        role: "assistant",
        turnId: "turn-plan",
        content: JSON.stringify([{ type: "text", content: "First text message" }]),
        createdAt: "2026-06-13T00:00:00.000Z",
      },
      {
        id: "trace-plan",
        sessionId: "s-1",
        role: "trace",
        turnId: "turn-plan",
        content: "[]",
        createdAt: "2026-06-13T00:00:01.000Z",
        traceSummary: {
          distinctApps: [],
          totalSteps: 1,
          invocationCounts: {},
          plan: { steps: [{ text: "Verify the result", status: "completed" }] },
        },
      },
      {
        id: "a-plan-2",
        sessionId: "s-1",
        role: "assistant",
        turnId: "turn-plan",
        content: JSON.stringify([{ type: "text", content: "Last text message" }]),
        createdAt: "2026-06-13T00:00:02.000Z",
      },
      {
        id: "a-plan-recap",
        sessionId: "s-1",
        role: "assistant",
        turnId: "turn-plan",
        content: JSON.stringify([{ type: "turn_recap", content: "Concise recap" }]),
        createdAt: "2026-06-13T00:00:03.000Z",
      },
    ];
    const rows = buildRows(messages, new Map([["s-1", IDENTITY]]), IDENTITY, {
      runningTurnId: null,
      isStreaming: false,
    });
    const actions: BlockActions = {
      onApprovalResolved: () => {},
      onSubmitAppComponent: () => {},
      onDismissAppComponent: () => {},
      interactionResults: new Map(),
    };

    render(
      <ThemeProvider>
        <MessageList
          rows={rows}
          live={{
            isStreaming: false,
            runningTurnId: null,
            snapshot: null,
            text: "",
            identity: IDENTITY,
          }}
          contentRef={() => {}}
          onOpenLiveTrace={() => {}}
          onOpenStoredTrace={() => {}}
          actions={actions}
        />
      </ThemeProvider>,
    );

    const lastText = screen.getByText("Last text message");
    const group = screen.getByLabelText("Turn summary");
    const planToggle = within(group).getByRole("button", { name: /Plan Completed 1 of 1/ });
    const recapToggle = within(group).getByRole("button", { name: "Recap" });
    const recapContent = document.getElementById(recapToggle.getAttribute("aria-controls") ?? "");

    expect(lastText.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.querySelectorAll("[data-summary-item]").length).toBe(2);
    expect(planToggle.getAttribute("aria-expanded")).toBe("false");
    expect(recapToggle.getAttribute("aria-expanded")).toBe("false");
    expect(recapContent?.hidden).toBe(true);

    fireEvent.click(recapToggle);

    expect(recapToggle.getAttribute("aria-expanded")).toBe("true");
    expect(recapContent?.hidden).toBe(false);
    expect(screen.getByText("Concise recap")).toBeTruthy();
  });
});

// The timeline rail finds its scroll targets by this attribute, and Chat paints
// the post-jump landing tint on the same wrapper. Both break silently if a
// render branch drops it, so each branch is covered.
function questionTurn(text: string, id: string, turnId?: string): ChatMessage {
  return {
    id,
    sessionId: "s-1",
    ...(turnId ? { turnId } : {}),
    role: "user",
    content: text,
    createdAt: "2026-06-13T00:00:00.000Z",
  };
}

function settledList(messages: ChatMessage[], selection?: ShareSelection) {
  const actions: BlockActions = {
    onApprovalResolved: () => {},
    onSubmitAppComponent: () => {},
    onDismissAppComponent: () => {},
    interactionResults: new Map(),
  };
  return (
    <ThemeProvider>
      <MessageList
        rows={buildRows(messages, new Map([["s-1", IDENTITY]]), IDENTITY, {
          runningTurnId: null,
          isStreaming: false,
        })}
        live={{
          isStreaming: false,
          runningTurnId: null,
          snapshot: null,
          text: "",
          identity: IDENTITY,
        }}
        selection={selection}
        contentRef={() => {}}
        onOpenLiveTrace={() => {}}
        onOpenStoredTrace={() => {}}
        actions={actions}
      />
    </ThemeProvider>
  );
}

function anchorIds(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll("[data-timeline-anchor]")].map((el) =>
    el.getAttribute("data-timeline-anchor"),
  );
}

describe("timeline anchors", () => {
  it("tags every user row with its message id, and nothing else", () => {
    const first = questionTurn("first question", "u-first");
    const second = questionTurn("second question", "u-second");
    const { container } = render(settledList([first, commentary("an answer", "a-answer"), second]));

    expect(anchorIds(container)).toEqual(["u-first", "u-second"]);
  });

  it("keeps the anchor on a selectable row during share selection", () => {
    // Share mode wraps the row in SelectableRow with a click overlay. The
    // anchor has to survive that branch or the rail silently stops working
    // whenever share mode is on.
    const question = questionTurn("still addressable", "u-share", "turn-9");
    const { container } = render(
      settledList([question], {
        active: true,
        selectedTurns: new Set<string>(),
        selectableSessionId: "s-1",
        onToggleTurn: () => {},
      }),
    );

    expect(anchorIds(container)).toEqual(["u-share"]);
    // The overlay still works — the anchor wrapper sits inside SelectableRow,
    // not around it, so it cannot swallow the toggle.
    expect(screen.getByRole("button", { name: "Select message" })).toBeTruthy();
  });

  it("keeps the anchor on a row share mode cannot select", () => {
    // No turnId, so this row is dimmed rather than made selectable — a third
    // render branch, and it still has to carry the anchor.
    const question = questionTurn("no turn id", "u-dimmed");
    const { container } = render(
      settledList([question], {
        active: true,
        selectedTurns: new Set<string>(),
        selectableSessionId: "s-1",
        onToggleTurn: () => {},
      }),
    );

    expect(anchorIds(container)).toEqual(["u-dimmed"]);
  });
});
