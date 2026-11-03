// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatMessage } from "@/lib/chat-types";
import "@/i18n";
import { EMPTY_LIVE_TEXT } from "@/hooks/live-text";
import { ThemeProvider } from "@/hooks/use-theme";
import { ConciergeTranscript } from "./ConciergeTranscript";
import type { ChatRow } from "./chat-view";
import type { BlockActions, LivePreview } from "./MessageList";
import {
  ReplyDraftProvider,
  replyFormFields,
  useReplyDraftState,
  type ReplyTarget,
} from "./reply/reply-draft";

rs.mock("@/hooks/use-dashboard-identity", () => ({
  useDashboardIdentity: () => ({
    data: { kind: "guardian", userId: "seat", displayName: "Ray", avatarUrl: null },
  }),
}));

beforeEach(() => {
  rs.stubGlobal("IntersectionObserver", undefined);
  rs.stubGlobal(
    "matchMedia",
    rs.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener: rs.fn(),
      removeEventListener: rs.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  rs.unstubAllGlobals();
});

const LEAD = "Here it is";
const REPORT = "# Report\n\nThree options.";
const at = new Date(2026, 9, 28, 12, 0, 0).toISOString();

const agentRow = (id: string, parts: unknown[]): ChatRow =>
  ({
    kind: "agent",
    key: id,
    identity: { name: "Rome", iconUrl: null },
    trace: null,
    messages: [
      {
        id,
        sessionId: "concierge",
        turnId: "t1",
        role: "assistant",
        content: JSON.stringify(parts),
        createdAt: at,
      } as ChatMessage,
    ],
  }) as ChatRow;

const actions = {
  onApprovalResolved: () => {},
  onSubmitAppComponent: () => {},
  onDismissAppComponent: () => {},
  interactionResults: new Map(),
} as BlockActions;
const idle = {
  isStreaming: false,
  runningTurnId: null,
  snapshot: null,
  textStore: EMPTY_LIVE_TEXT,
  identity: { name: "Rome", iconUrl: null },
} as LivePreview;

/**
 * The transcript with the real reply draft state. `sent` is the form fields the
 * chat would post for the reply the guardian picked last.
 */
function renderChat(rows: ChatRow[]) {
  const box: { target: ReplyTarget | null } = { target: null };
  function Chat() {
    const draft = useReplyDraftState({
      chatId: "concierge",
      sessionId: "concierge",
      messageIds: new Set(["m1"]),
      jump: () => {},
      focusComposer: () => {},
    });
    box.target = draft.target;
    return (
      <MemoryRouter>
        <ReplyDraftProvider value={draft}>
          <ThemeProvider>
            <ConciergeTranscript rows={rows} live={idle} actions={actions} contentRef={() => {}} />
          </ThemeProvider>
        </ReplyDraftProvider>
      </MemoryRouter>
    );
  }
  render(<Chat />);
  return () => (box.target ? replyFormFields(box.target) : null);
}

const forward = [
  { type: "text", content: LEAD },
  {
    type: "text",
    content: REPORT,
    format: "long",
    forwardedFrom: { chatId: "task-1", title: "Flights" },
  },
];

describe("the reply the toolbar and the tap row send", () => {
  it("quotes the lead-in alone from the row a tap opens on a phone", () => {
    rs.stubGlobal(
      "matchMedia",
      rs.fn((query: string) => ({
        matches: query === "(hover: none)",
        media: query,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    );
    const sent = renderChat([agentRow("m1", forward)]);

    fireEvent.click(screen.getByText(LEAD));
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(sent()).toEqual({ replyToMessageId: "m1", replyQuote: LEAD });
  });

  it("keeps the toolbar outside the clipped text and clear of the chip's row", () => {
    renderChat([agentRow("m1", forward)]);

    const toolbars = document.querySelectorAll("[data-bubble-toolbar]");
    expect(toolbars).toHaveLength(2);
    // Over the bubble's top edge, out of layout, as a sibling of the bubble.
    for (const toolbar of toolbars) {
      expect(toolbar.className).toContain("absolute");
      expect(toolbar.className).toContain("bottom-full");
      expect(toolbar.closest("[data-concierge-bubble]")).toBeNull();
    }
    // The toolbar overlaps 12px of the bubble: the border and padding take 9px, so the chip adds 4.
    expect(screen.getByRole("link", { name: "Open task chat Flights" }).className).toContain(
      "mt-1",
    );
  });
});

describe("the reply a Concierge bubble sends", () => {
  it("quotes the lead-in alone, not the whole message, when the message holds several bubbles", () => {
    const sent = renderChat([agentRow("m1", forward)]);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]);

    expect(sent()).toEqual({ replyToMessageId: "m1", replyQuote: LEAD });
  });

  it("quotes the report alone from the report's bubble", () => {
    const sent = renderChat([agentRow("m1", forward)]);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]);

    expect(sent()).toEqual({ replyToMessageId: "m1", replyQuote: REPORT });
  });

  it("sends a selection in preference to the bubble's text", () => {
    const sent = renderChat([agentRow("m1", forward)]);
    const line = screen.getByText("Three options.");
    window.getSelection()?.selectAllChildren(line);

    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[1]);

    expect(sent()).toEqual({ replyToMessageId: "m1", replyQuote: "Three options." });
  });

  it("sends no quote from a message of one bubble, which the server snapshots whole", () => {
    const sent = renderChat([agentRow("m1", [{ type: "text", content: LEAD }])]);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(sent()).toEqual({ replyToMessageId: "m1" });
  });
});
