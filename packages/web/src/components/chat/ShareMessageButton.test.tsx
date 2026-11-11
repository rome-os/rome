// @rstest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import "@/i18n";
import { getMessageShare, revokeShare, shareMessage } from "@/lib/chat-api";
import { ConciergeMessageMeta } from "./ConciergeMessageMeta";
import { MessageSharingContext, ShareMessageButton } from "./ShareMessageButton";
import { TurnActions } from "./TurnActions";

rs.mock("@/lib/chat-api", () => ({
  getMessageShare: rs.fn(),
  revokeShare: rs.fn(),
  shareMessage: rs.fn(),
}));
rs.mock("./TurnFeedbackButtons", () => ({ TurnFeedbackButtons: () => null }));
rs.mock("./TurnBranchButton", () => ({ TurnBranchButton: () => null }));

const LINK = { id: "tok", url: "/share/tok", title: "Day one", createdAt: "2026-11-10T10:00:00Z" };
const URL_TEXT = `${window.location.origin}/share/tok`;

beforeEach(() => {
  rs.mocked(getMessageShare).mockResolvedValue(null);
  rs.mocked(shareMessage).mockResolvedValue(LINK);
  rs.mocked(revokeShare).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  rs.clearAllMocks();
  rs.unstubAllGlobals();
});

const reply = {
  messageId: "m-1",
  sessionId: "topic-1",
  author: "agent" as const,
  text: "## Day one\nWalk the Alfama.",
};

const live = (node: ReactNode) =>
  render(<MessageSharingContext.Provider value>{node}</MessageSharingContext.Provider>);

const openCard = async () => {
  const user = userEvent.setup();
  live(<ShareMessageButton sessionId="topic-1" messageId="m-1" preview={reply.text} />);
  await user.click(screen.getByRole("button", { name: "Share" }));
  const card = await screen.findByRole("dialog", { name: "Share message" });
  return { user, card };
};

describe("Share on a message", () => {
  it("previews the message and makes no link until Create link", async () => {
    const { user } = await openCard();
    expect(screen.getByText("Day one Walk the Alfama.")).toBeTruthy();
    expect(screen.getByText("Anyone with the link can view this message.")).toBeTruthy();
    const create = await screen.findByRole("button", { name: "Create link" });
    expect(shareMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Link" })).toBeNull();

    await user.click(create);
    expect(shareMessage).toHaveBeenCalledWith("topic-1", "m-1");
    const field = (await screen.findByRole("textbox", { name: "Link" })) as HTMLInputElement;
    expect(field.value).toBe(URL_TEXT);
    expect(field.readOnly).toBe(true);
  });

  it("copies the link from the card", async () => {
    rs.mocked(getMessageShare).mockResolvedValue(LINK);
    const { user } = await openCard();
    await user.click(await screen.findByRole("button", { name: "Copy" }));
    // user-event stands in for the clipboard.
    expect(await navigator.clipboard.readText()).toBe(URL_TEXT);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("opens on the message's existing link, and Stop sharing revokes it", async () => {
    rs.mocked(getMessageShare).mockResolvedValue(LINK);
    const { user } = await openCard();
    expect(((await screen.findByRole("textbox", { name: "Link" })) as HTMLInputElement).value).toBe(
      URL_TEXT,
    );
    expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Stop sharing" }));
    expect(revokeShare).toHaveBeenCalledWith("tok");
    expect(await screen.findByRole("button", { name: "Create link" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Link" })).toBeNull();
  });

  it("moves focus into the card, and Esc closes it", async () => {
    const { user, card } = await openCard();
    await screen.findByRole("button", { name: "Create link" });
    await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when the link can't be made", async () => {
    rs.mocked(shareMessage).mockRejectedValue(new Error("nope"));
    const { user } = await openCard();
    await user.click(await screen.findByRole("button", { name: "Create link" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not create the link.");
  });

  it("is offered on a Concierge bubble and under a common chat's answer", () => {
    live(
      <>
        <ConciergeMessageMeta copyText="Day one" createdAt="" feedbackTurn={null} reply={reply} />
        <TurnActions copyText="Day one" feedbackTurn={null} showBranch={false} reply={reply} />
      </>,
    );
    expect(screen.getAllByRole("button", { name: "Share" })).toHaveLength(2);
  });

  it("is not offered on a surface that does not turn sharing on, such as a shared chat", () => {
    render(
      <ConciergeMessageMeta copyText="Day one" createdAt="" feedbackTurn={null} reply={reply} />,
    );
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeTruthy();
  });
});
