// @rstest-environment jsdom
import i18n from "@/i18n";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: null, avatarUrl: null },
  }),
}));
import { type AgentIdentity, buildRows } from "./chat-view";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { BlockActions, LivePreview, ShareSelection } from "./MessageList";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatMessage } from "@/lib/chat-types";
import { questionCardRender } from "../../../mock/fixtures/question-card";

afterEach(() => cleanup());

const IDENTITY: AgentIdentity = { name: "Concierge", iconUrl: null };
const live: LivePreview = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: IDENTITY,
};
const actions: BlockActions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
};

const user = (id: string, turnId: string): ChatMessage => ({
  id,
  sessionId: "concierge",
  turnId,
  role: "user",
  content: `asked ${id}`,
  createdAt: "2026-10-27T00:00:00.000Z",
});
const agent = (id: string, turnId: string): ChatMessage => ({
  id,
  sessionId: "concierge",
  turnId,
  role: "assistant",
  content: JSON.stringify([{ type: "text", content: `said ${id}` }]),
  createdAt: "2026-10-27T00:00:00.000Z",
});

function transcript(
  messages: ChatMessage[],
  streaming = false,
  quiet = false,
  snapshot: LivePreview["snapshot"] = null,
) {
  const rows = buildRows(messages, new Map(), IDENTITY, {
    runningTurnId: streaming ? "t9" : null,
    isStreaming: streaming,
  });
  return (
    <ThemeProvider>
      <ConciergeTranscript
        rows={rows}
        live={{
          ...live,
          isStreaming: streaming,
          runningTurnId: streaming ? "t9" : null,
          quiet,
          snapshot,
        }}
        actions={actions}
        contentRef={() => {}}
      />
    </ThemeProvider>
  );
}

// Each entering bubble as "<user message id | agent text>@<step>".
function entering(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-arrival]")).map(
    (el) => `${el.dataset.timelineAnchor ?? el.textContent?.trim()}@${el.dataset.arrival}`,
  );
}

const history = [user("u1", "t1"), agent("a1", "t1"), agent("a2", "t1")];

describe("ConciergeTranscript bubble arrival", () => {
  it("shows the history in place and brings later bubbles in, stepped per batch", () => {
    const { container, rerender } = render(transcript(history));
    expect(entering(container)).toEqual([]);

    // The guardian's own bubble enters too.
    rerender(transcript([...history, user("u2", "t2")]));
    expect(entering(container)).toEqual(["u2@0"]);

    const batch = [user("u2", "t2"), agent("a3", "t2"), agent("a4", "t2")];
    rerender(transcript([...history, ...batch, agent("a5", "t2"), agent("a6", "t2")]));
    // The fourth bubble of a batch shares the third's step.
    expect(entering(container)).toEqual([
      "u2@0",
      "said a3@0",
      "said a4@1",
      "said a5@2",
      "said a6@2",
    ]);

    rerender(
      transcript([
        ...history,
        ...batch,
        agent("a5", "t2"),
        agent("a6", "t2"),
        user("u3", "t3"),
        agent("a7", "t3"),
      ]),
    );
    // A new batch starts at step 0; earlier bubbles keep theirs.
    expect(entering(container)).toEqual([
      "u2@0",
      "said a3@0",
      "said a4@1",
      "said a5@2",
      "said a6@2",
      "u3@0",
      "said a7@1",
    ]);
  });

  it("does not bring in the history that loads after the transcript mounts", () => {
    const { container, rerender } = render(transcript([]));
    rerender(transcript(history));
    expect(entering(container)).toEqual([]);
  });

  it("does not bring in older history paged in above, or a refetch of the same messages", () => {
    const recent = [user("u2", "t2"), agent("a3", "t2")];
    const { container, rerender } = render(transcript(recent));
    rerender(transcript([...history, ...recent]));
    expect(entering(container)).toEqual([]);
    rerender(transcript([...history, ...recent].map((m) => ({ ...m }))));
    expect(entering(container)).toEqual([]);
  });
});

describe("ConciergeTranscript when the loaded history is replaced", () => {
  it("shows the newest page that replaces the transcript in place", () => {
    const { container, rerender } = render(transcript(history));
    rerender(transcript([user("u8", "t8"), agent("a8", "t8"), agent("a9", "t8")]));
    expect(entering(container)).toEqual([]);

    // Later bubbles still enter.
    rerender(
      transcript([user("u8", "t8"), agent("a8", "t8"), agent("a9", "t8"), user("u9", "t9")]),
    );
    expect(entering(container)).toEqual(["u9@0"]);
  });
});

describe("ConciergeTranscript as a live log", () => {
  it("is a log of additions, busy while a turn runs", () => {
    const { getByRole, rerender } = render(transcript(history, true));
    const log = getByRole("log");
    expect(log.getAttribute("aria-relevant")).toBe("additions");
    expect(log.getAttribute("aria-busy")).toBe("true");
    rerender(transcript(history));
    expect(getByRole("log").hasAttribute("aria-busy")).toBe(false);
  });
});

describe("bubble arrival styles", () => {
  const css = readFileSync(new URL("../../globals.css", import.meta.url), "utf8");

  it("fades and rises an arriving bubble in 180ms, 60ms apart", () => {
    expect(css).toMatch(
      /\[data-arrival\] \{\s*animation: rome-bubble-enter 180ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/,
    );
    expect(css).toMatch(/\[data-arrival="1"\] \{\s*animation-delay: 60ms;/);
    expect(css).toMatch(/\[data-arrival="2"\] \{\s*animation-delay: 120ms;/);
    expect(css).toMatch(
      /@keyframes rome-bubble-enter \{\s*from \{\s*opacity: 0;\s*transform: translateY\(8px\);/,
    );
  });

  it("turns the entrance off under reduced motion", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\[data-arrival\] \{\s*animation: none;/,
    );
  });
});

describe("ConciergeTranscript waiting cards", () => {
  it("tags a card with its message, so Needs you can tell it is in the current reply", async () => {
    const question: ChatMessage = {
      ...agent("a1", "t1"),
      content: JSON.stringify([
        {
          type: "pending_interaction",
          toolUseId: "q1",
          appId: "core",
          render: questionCardRender([{ id: "day", question: "Which day?", type: "text" }]),
        },
        { type: "text", content: "Pick a day above." },
      ]),
    };
    const { container } = render(transcript([user("u1", "t1"), question]));
    const card = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-chat-pending-card]");
      if (!found) throw new Error("the card has not drawn yet");
      return found;
    });
    expect(card.closest<HTMLElement>("[data-chat-card-message]")?.dataset.chatCardMessage).toBe(
      "a1",
    );
  });
});

describe("ConciergeTranscript typing indicator", () => {
  const dots = (container: HTMLElement) =>
    container.querySelector('[role="status"][aria-label="Typing"]');

  it("shows the typing dots while a turn runs", () => {
    const { container } = render(transcript(history, true));
    expect(dots(container)).not.toBeNull();
  });

  it("shows no dots for a quiet turn that has said nothing, and does not mark the log busy", () => {
    const { container, getByRole } = render(transcript(history, true, true));
    expect(dots(container)).toBeNull();
    expect(getByRole("log").hasAttribute("aria-busy")).toBe(false);
  });

  it("hides the dots once the turn has said something, and shows them while it works on", () => {
    const { container, rerender } = render(transcript(history, true));
    expect(dots(container)).not.toBeNull();
    // The turn's message lands; it only closes off after it.
    rerender(transcript([...history, agent("a9", "t9")], true));
    expect(dots(container)).toBeNull();
    // It starts another call.
    const working = {
      segments: [
        {
          kind: "block" as const,
          id: "b0",
          ordinal: 0,
          block: { type: "tool_use" as const, id: "w1", tool: "WebSearch", input: {} },
        },
      ],
      summary: { distinctApps: [], totalSteps: 0, invocationCounts: {} },
    };
    rerender(transcript([...history, agent("a9", "t9")], true, false, working));
    expect(dots(container)).not.toBeNull();
  });

  it("does not take another turn's message for the quiet turn speaking", () => {
    const { container } = render(transcript([...history, agent("a9", "t8")], true, true));
    expect(dots(container)).toBeNull();
  });
});

it.each([
  "en",
  "zh-CN",
])("renders the automatic quota notice in %s even with no recovery output", async (locale) => {
  await i18n.changeLanguage(locale);
  try {
    const message = {
      ...agent("switch", "host"),
      content: JSON.stringify([
        { type: "quota_switch", from: "anthropic", to: "openai", model: "gpt-6-luna" },
      ]),
    };
    const trace = (id: string, model: string): ChatMessage => ({
      ...agent(id, id),
      role: "trace",
      content: "[]",
      traceSummary: {
        model,
        distinctApps: [],
        invocationCounts: {},
        totalSteps: 0,
        terminalError: "Recovery failed",
      },
    });
    const { getByRole, container } = render(
      transcript([
        trace("old", "claude-sonnet-5-5"),
        message,
        trace("failed-recovery", "gpt-6-luna"),
      ]),
    );
    expect(getByRole("note").textContent).toBe(
      locale === "en"
        ? "Claude quota ran out, switched to Codex"
        : "Claude 额度已用完，已切换到 Codex",
    );
    expect(container.querySelector("[data-chat-card-message]")).toBeNull();
    expect(container.querySelector("[data-chat-message]")).toBeNull();
  } finally {
    await i18n.changeLanguage("en");
  }
});

describe("ConciergeTranscript in share mode", () => {
  const messages = [
    user("u1", "t1"),
    agent("a1", "t1"),
    user("u2", "t2"),
    agent("a2", "t2"),
    { ...agent("x1", "t3"), sessionId: "elsewhere" },
  ];
  const shareMode = (selection?: ShareSelection) => {
    const rows = buildRows(messages, new Map(), IDENTITY, {
      runningTurnId: null,
      isStreaming: false,
    });
    return (
      <ThemeProvider>
        <ConciergeTranscript
          rows={rows}
          live={live}
          selection={selection}
          actions={actions}
          contentRef={() => {}}
        />
      </ThemeProvider>
    );
  };
  const row = (text: string) => screen.getByText(text).closest("[data-share-pick]") as HTMLElement;

  it("draws no pickers outside share mode", () => {
    render(shareMode());
    expect(screen.queryByRole("button", { name: /select message/i })).toBeNull();
  });

  it("marks every bubble of a picked turn, and toggles the turn from any of them", () => {
    const onToggleTurn = rs.fn();
    render(
      shareMode({
        selectedTurns: new Set(["t2"]),
        selectableSessionId: "concierge",
        onToggleTurn,
      }),
    );
    for (const text of ["asked u2", "said a2"]) {
      expect(within(row(text)).getByRole("button", { name: "Deselect message" })).toBeTruthy();
    }
    for (const text of ["asked u1", "said a1"]) {
      expect(within(row(text)).getByRole("button", { name: "Select message" })).toBeTruthy();
    }
    fireEvent.click(within(row("said a1")).getByRole("button", { name: "Select message" }));
    fireEvent.click(within(row("asked u2")).getByRole("button", { name: "Deselect message" }));
    expect(onToggleTurn.mock.calls).toEqual([["t1"], ["t2"]]);
  });

  it("does not offer a bubble of another session", () => {
    render(
      shareMode({
        selectedTurns: new Set(),
        selectableSessionId: "concierge",
        onToggleTurn: rs.fn(),
      }),
    );
    // Two turns of two bubbles each; the other session's bubble has none.
    expect(screen.getAllByRole("button", { name: /select message/i })).toHaveLength(4);
  });
});
