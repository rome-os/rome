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
import { findMessageAnchor } from "./reply/reply-source";

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
  return Object.assign(() => (box.target ? replyFormFields(box.target) : null), {
    target: () => box.target,
  });
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

  it("leaves the tap row closed when a tap on a phone lands on a picture", () => {
    rs.stubGlobal(
      "matchMedia",
      rs.fn((query: string) => ({
        matches: query === "(hover: none)",
        media: query,
        addEventListener: rs.fn(),
        removeEventListener: rs.fn(),
      })),
    );
    renderChat([
      agentRow("m1", [
        { type: "text", content: "A note\n\n![A chart](https://example.com/chart.png)" },
      ]),
    ]);

    fireEvent.click(screen.getByAltText("A chart"));
    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();

    fireEvent.click(screen.getByText("A note"));
    expect(screen.getByRole("button", { name: "Reply" })).toBeTruthy();
  });

  it("keeps the toolbar outside the clipped text, over the bubble's top edge", () => {
    renderChat([agentRow("m1", forward)]);

    const toolbars = document.querySelectorAll("[data-bubble-toolbar]");
    expect(toolbars).toHaveLength(2);
    // Over the bubble's top edge, out of layout, as a sibling of the bubble.
    for (const toolbar of toolbars) {
      expect(toolbar.className).toContain("absolute");
      expect(toolbar.className).toContain("bottom-full");
      expect(toolbar.closest("[data-concierge-bubble]")).toBeNull();
    }
    // The toolbar overlaps 8px of the bubble, inside its 9px of border and padding.
    for (const toolbar of toolbars) expect(toolbar.className).toContain("translate-y-2");
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

it("keeps an on-behalf source with the guardian's messages and names the source in a reply", () => {
  const message: ChatMessage = {
    id: "m1",
    sessionId: "concierge",
    role: "user",
    createdAt: at,
    content: JSON.stringify([{ type: "text", content: "Find flights" }]),
    sender: {
      kind: "automated",
      sourceType: "agent",
      name: "Concierge",
      iconUrl: null,
      onBehalfOf: { kind: "guardian", name: "Ray", avatarUrl: null },
    },
  };
  const sent = renderChat([{ kind: "user", key: message.id, message }]);
  expect(screen.getByText("Find flights").closest(".justify-end")).not.toBeNull();
  expect(screen.getByText("Sent by Concierge")).toBeTruthy();
  expect(screen.getByTitle("Ray")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(sent()).toEqual({ replyToMessageId: "m1" });
  expect(sent.target()).toMatchObject({
    author: "automated",
    name: "Concierge",
    preview: "Find flights",
  });
});

it("anchors an automated message, so a selection quotes it and a jump can find it", () => {
  const message: ChatMessage = {
    id: "m1",
    sessionId: "concierge",
    role: "user",
    createdAt: at,
    content: JSON.stringify([{ type: "text", content: "Find flights\n\nBook the cheapest" }]),
    sender: {
      kind: "automated",
      sourceType: "agent",
      name: "Concierge",
      iconUrl: null,
      onBehalfOf: { kind: "guardian", name: "Ray", avatarUrl: null },
    },
  };
  const sent = renderChat([{ kind: "user", key: message.id, message }]);
  const line = screen.getByText("Book the cheapest");
  expect(findMessageAnchor(document, "m1")?.contains(line)).toBe(true);

  window.getSelection()?.selectAllChildren(line);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));

  expect(sent()).toEqual({ replyToMessageId: "m1", replyQuote: "Book the cheapest" });
});
