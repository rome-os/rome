// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import { ConciergeEmptyState, ConciergeTopicEmptyState } from "./ConciergeEmptyState";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

describe("ConciergeEmptyState", () => {
  it("invites a request in one line and offers four example messages", () => {
    render(<ConciergeEmptyState onPick={() => {}} />);
    const region = screen.getByRole("region", { name: "Just tell me what you want to get done" });
    // One line of text: no description under it.
    expect(region.querySelector('[data-slot="empty-state-description"]')).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "What's the weather today?",
      "Remind me to stretch in an hour",
      "Summarize my unread email",
      "Build me a simple habit tracker app",
    ]);
  });

  it("hands the picked example's text to onPick", async () => {
    const onPick = rs.fn();
    render(<ConciergeEmptyState onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "Summarize my unread email" }));
    expect(onPick).toHaveBeenCalledWith("Summarize my unread email");
  });

  it("offers the examples in the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    const onPick = rs.fn();
    render(<ConciergeEmptyState onPick={onPick} />);
    await userEvent.click(screen.getByRole("button", { name: "总结一下我的未读邮件" }));
    expect(onPick).toHaveBeenCalledWith("总结一下我的未读邮件");
  });
});

describe("ConciergeTopicEmptyState", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("offers three short suggestions at once, with no request, and hands over the picked one's full message", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    const onStart = rs.fn();
    render(<ConciergeTopicEmptyState onStart={onStart} />);
    const region = screen.getByRole("region", { name: "Suggestions" });
    // Only the suggestions: no title, description, link or icon.
    expect(region.textContent).toBe(
      "Keep my bills and errands hereTrack my work and meetingsPlan next month's trip",
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(region.querySelector("svg")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Track my work and meetings" }));
    expect(onStart).toHaveBeenCalledWith("Track my work here: project progress, PRs and meetings");
  });

  it("offers them in the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    const onStart = rs.fn();
    render(<ConciergeTopicEmptyState onStart={onStart} />);
    expect(screen.getByRole("region", { name: "建议" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "账单和杂事放这里",
      "跟进工作和会议",
      "规划下个月的旅行",
    ]);
    await userEvent.click(screen.getByRole("button", { name: "规划下个月的旅行" }));
    expect(onStart).toHaveBeenCalledWith("帮我规划下个月的旅行，相关的事都放在这里");
    await i18n.changeLanguage("en");
  });
});
