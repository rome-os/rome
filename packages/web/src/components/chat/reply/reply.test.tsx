// @rstest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { QuotedReply } from "./QuotedReply";
import { ReplyButton } from "./ReplyButton";
import { ReplyBar } from "./ReplyBar";
import {
  ReplyDraftProvider,
  useReplyDraftState,
  type ReplyDraft,
  type ReplyTarget,
} from "./reply-draft";
import { findMessageAnchor } from "./reply-source";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

function draftOf(overrides: Partial<ReplyDraft> = {}): ReplyDraft {
  return {
    sessionId: "s1",
    target: null,
    set: rs.fn(),
    clear: rs.fn(),
    restore: rs.fn(),
    has: () => true,
    jump: rs.fn(),
    ...overrides,
  };
}

const withDraft = (draft: ReplyDraft, children: ReactNode) => (
  <ReplyDraftProvider value={draft}>{children}</ReplyDraftProvider>
);

const source = {
  messageId: "m1",
  sessionId: "s1",
  author: "agent" as const,
  text: "Fly to Lisbon.\nStay in Alfama.",
};

describe("ReplyBar", () => {
  const target: ReplyTarget = { messageId: "m1", author: "agent", preview: "Fly to Lisbon." };

  it("spans the composer with an arrow, the muted quote, and × at the end", () => {
    const { container } = render(withDraft(draftOf({ target }), <ReplyBar />));

    const bar = container.querySelector("[data-reply-bar]") as HTMLElement;
    expect(bar.className).toContain("w-full");
    expect(bar.className).toContain("text-muted-foreground");
    expect(bar.className).toContain("rounded-8");
    expect(bar.className).toContain("border-l-3");
    expect(bar.className).toContain("border-muted-foreground");
    expect(bar.className).not.toContain("primary");
    expect(bar.querySelector("[data-reply-accent]")).toBeNull();
    expect(screen.getByRole("img", { name: "Reply" })).toBeTruthy();
    expect(bar.lastElementChild?.getAttribute("aria-label")).toBe("Cancel reply");
    expect(screen.getByText("Fly to Lisbon.").className).toContain("line-clamp-2");
    expect(screen.queryByText(/Replying to|Assistant/)).toBeNull();
  });

  it("dismisses the reply from its ×", () => {
    const draft = draftOf({ target });
    render(withDraft(draft, <ReplyBar />));

    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(draft.clear).toHaveBeenCalledOnce();
  });

  it("draws nothing without a reply", () => {
    const { container } = render(withDraft(draftOf(), <ReplyBar />));

    expect(container.textContent).toBe("");
  });
});

describe("ReplyButton", () => {
  const scope = (
    <div data-timeline-anchor="m0 m1">
      <p>Fly to Lisbon.</p>
      <p>Stay in Alfama.</p>
    </div>
  );

  it("offers no Reply where the chat has no reply state", () => {
    render(<ReplyButton source={source} />);

    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("offers no Reply for a message of a session the composer does not send to", () => {
    render(withDraft(draftOf({ sessionId: "other" }), <ReplyButton source={source} />));

    expect(screen.queryByRole("button", { name: "Reply" })).toBeNull();
  });

  it("replies to the whole message when nothing is selected", () => {
    const draft = draftOf();
    const onReply = rs.fn();
    render(withDraft(draft, <ReplyButton source={source} onReply={onReply} />));

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set).toHaveBeenCalledWith({
      messageId: "m1",
      author: "agent",
      preview: "Fly to Lisbon.\nStay in Alfama.",
    });
    expect(onReply).toHaveBeenCalledOnce();
  });

  it("quotes a selection inside the message", () => {
    const draft = draftOf();
    render(
      withDraft(
        draft,
        <>
          {scope}
          <ReplyButton source={source} />
        </>,
      ),
    );
    const paragraph = screen.getByText("Stay in Alfama.");
    window.getSelection()?.selectAllChildren(paragraph);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set).toHaveBeenCalledWith(
      expect.objectContaining({ quote: "Stay in Alfama.", preview: "Stay in Alfama." }),
    );
  });

  it("replies to the whole message when the selection leaves it", () => {
    const draft = draftOf();
    render(
      withDraft(
        draft,
        <>
          {scope}
          <p>Elsewhere on the page.</p>
          <ReplyButton source={source} />
        </>,
      ),
    );
    window
      .getSelection()
      ?.selectAllChildren(screen.getByText("Elsewhere on the page.").parentElement!);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set.mock.calls[0][0]).not.toHaveProperty("quote");
  });

  it("replies to the whole message when the selection is not in the message's source text", () => {
    const draft = draftOf();
    render(
      withDraft(
        draft,
        <>
          <div data-timeline-anchor="m1">
            <strong>Lisbon</strong>.
          </div>
          <ReplyButton source={{ ...source, text: "Fly to **Lisbon**." }} />
        </>,
      ),
    );
    // The rendered "Lisbon." has no counterpart in the source, which has the markers between.
    window.getSelection()?.selectAllChildren(screen.getByText("Lisbon").parentElement!);

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(draft.set.mock.calls[0][0]).not.toHaveProperty("quote");
  });

  it("caps the preview at what core stores", () => {
    const draft = draftOf();
    render(withDraft(draft, <ReplyButton source={{ ...source, text: "x".repeat(1500) }} />));

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    const { preview } = draft.set.mock.calls[0][0] as ReplyTarget;
    expect(preview).toHaveLength(1000);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("QuotedReply", () => {
  const part = {
    type: "reply_to" as const,
    messageId: "m1",
    author: "agent" as const,
    text: "Fly to Lisbon.",
  };

  it("jumps to the original when the transcript holds it", () => {
    const draft = draftOf();
    render(withDraft(draft, <QuotedReply part={part} />));

    fireEvent.click(screen.getByRole("button", { name: "Go to the original message" }));

    expect(draft.jump).toHaveBeenCalledWith("m1");
    expect(screen.getByText("Fly to Lisbon.")).toBeTruthy();
    expect(screen.queryByText("Assistant")).toBeNull();
  });

  it("reads markdown as plain text", () => {
    render(
      withDraft(
        draftOf(),
        <QuotedReply part={{ ...part, text: "**Day 1: Alfama**\n\n- Morning: the `Sé`" }} />,
      ),
    );

    expect(screen.getByText("Day 1: Alfama Morning: the Sé")).toBeTruthy();
  });

  it("edges the quote in the same rounded gray as the composer bar", () => {
    render(withDraft(draftOf(), <QuotedReply part={part} />));

    const quote = screen.getByRole("button", { name: "Go to the original message" });
    expect(quote.className).toContain("rounded-8");
    expect(quote.className).toContain("border-l-3");
    expect(quote.className).toContain("border-muted-foreground");
    expect(quote.querySelector("[data-reply-accent]")).toBeNull();
  });

  it("shows the snapshot without a button when the original is not loaded", () => {
    render(withDraft(draftOf({ has: () => false }), <QuotedReply part={part} />));

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Fly to Lisbon.")).toBeTruthy();
  });

  it("shows the snapshot without a button where the chat has no reply state", () => {
    render(<QuotedReply part={{ ...part, author: "guardian", name: "Ray" }} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Fly to Lisbon.")).toBeTruthy();
    expect(screen.queryByText("Ray")).toBeNull();
  });
});

// History may load only a window of the chat. A quote keeps working from its
// own snapshot and links to the original only while the window holds it.
describe("a quote whose original is outside the loaded history", () => {
  const part = {
    type: "reply_to" as const,
    messageId: "older",
    author: "agent" as const,
    text: "Fly to Lisbon.",
  };

  function Window({ loaded, jump }: { loaded: string[]; jump: (id: string) => void }) {
    const draft = useReplyDraftState({
      chatId: "chat-1",
      sessionId: "s1",
      messageIds: new Set(loaded),
      jump,
      focusComposer: () => {},
    });
    return withDraft(draft, <QuotedReply part={part} />);
  }

  it("shows the snapshot inertly, then links once older history loads", () => {
    const jump = rs.fn();
    const { rerender } = render(<Window loaded={["newer"]} jump={jump} />);

    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByText("Fly to Lisbon."));
    expect(jump).not.toHaveBeenCalled();

    rerender(<Window loaded={["older", "newer"]} jump={jump} />);
    fireEvent.click(screen.getByRole("button", { name: "Go to the original message" }));
    expect(jump).toHaveBeenCalledWith("older");
  });

  it("finds no anchor for a message the transcript does not draw", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div data-timeline-anchor="newer a2 a3"></div>';

    expect(findMessageAnchor(root, "older")).toBeNull();
    expect(findMessageAnchor(root, "a2")).toBe(root.firstElementChild);
  });
});
