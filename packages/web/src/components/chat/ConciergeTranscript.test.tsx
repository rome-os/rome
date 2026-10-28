// @rstest-environment jsdom
import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: null, avatarUrl: null },
  }),
}));
import { type AgentIdentity, buildRows } from "./chat-view";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { BlockActions, LivePreview } from "./MessageList";
import { ThemeProvider } from "@/hooks/use-theme";
import type { ChatMessage } from "@/lib/chat-types";

afterEach(() => cleanup());

const IDENTITY: AgentIdentity = { name: "Concierge", iconUrl: null };
const live: LivePreview = {
  isStreaming: false,
  runningTurnId: null,
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

function transcript(messages: ChatMessage[], streaming = false) {
  const rows = buildRows(messages, new Map(), IDENTITY, {
    runningTurnId: streaming ? "t9" : null,
    isStreaming: streaming,
  });
  return (
    <ThemeProvider>
      <ConciergeTranscript
        rows={rows}
        live={{ ...live, isStreaming: streaming, runningTurnId: streaming ? "t9" : null }}
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
  it("tags a card with its message, so Needs you can tell it is in the current reply", () => {
    const question: ChatMessage = {
      ...agent("a1", "t1"),
      content: JSON.stringify([
        {
          type: "pending_interaction",
          toolUseId: "q1",
          appId: "core",
          render: {
            kind: "inline",
            builtin: true,
            componentId: "question-card",
            props: { questions: [{ id: "day", question: "Which day?", type: "text" }] },
          },
        },
        { type: "text", content: "Pick a day above." },
      ]),
    };
    const { container } = render(transcript([user("u1", "t1"), question]));
    const card = container.querySelector<HTMLElement>("[data-chat-pending-card]");
    expect(card?.closest<HTMLElement>("[data-chat-card-message]")?.dataset.chatCardMessage).toBe(
      "a1",
    );
  });
});
