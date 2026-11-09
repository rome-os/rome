// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
  const renderTopic = (onStart = rs.fn()) =>
    render(
      <MemoryRouter>
        <ConciergeTopicEmptyState onStart={onStart} />
      </MemoryRouter>,
    );

  it("offers three topic kinds at once, with no request, and sends the picked one", async () => {
    const fetchSpy = rs.spyOn(globalThis, "fetch");
    const onStart = rs.fn();
    renderTopic(onStart);
    expect(screen.getByRole("region", { name: "Start an ongoing topic" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Be my life helper: schedule, bills, deliveries and other errands live here",
      "Keep track of work here: project progress, PRs and meetings",
      "Help me plan next month's trip, and keep everything about it here",
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const work = screen.getByRole("button", {
      name: "Keep track of work here: project progress, PRs and meetings",
    });
    // A long starter wraps inside its border and grows taller, at the column's width.
    expect(work.className).toContain("whitespace-normal");
    expect(work.className).toContain("w-full");
    await userEvent.click(work);
    expect(onStart).toHaveBeenCalledWith(
      "Keep track of work here: project progress, PRs and meetings",
    );
    expect(screen.getByRole("link", { name: "Ask in the main chat →" }).getAttribute("href")).toBe(
      "/message",
    );
  });

  it("offers them in the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    renderTopic();
    expect(screen.getByRole("region", { name: "开一个长期话题" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "当我的生活小助手：日程、账单、快递这些琐事都放这里",
      "帮我跟进工作上的事：项目进度、PR、会议都放这里",
      "帮我规划下个月的旅行，相关的事都放这里",
    ]);
    expect(screen.getByText("只是问个问题？")).toBeTruthy();
    await i18n.changeLanguage("en");
  });
});
