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
  const connector = (service: string, state: "working" | null, follows: string[] = []) => ({
    service,
    state,
    capabilities: { watch: { state: "unlocked", follows: follows.map((target) => ({ target })) } },
  });
  const serve = (connectors: unknown[]) =>
    rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((async (input: RequestInfo | URL) =>
        String(input) === "/api/concierge/connectors"
          ? Response.json({ connectors, rules: { digestTimes: [], quietHours: null } })
          : new Response("not found", { status: 404 })) as typeof fetch);
  const renderTopic = (onStart = rs.fn()) =>
    render(
      <MemoryRouter>
        <ConciergeTopicEmptyState onStart={onStart} />
      </MemoryRouter>,
    );

  it("says what a topic chat is for, and starts from the calendar and a followed repo the guardian has", async () => {
    serve([
      connector("googlecalendar", "working"),
      connector("github", "working", ["acme/widgets"]),
    ]);
    const onStart = rs.fn();
    renderTopic(onStart);
    expect(screen.getByRole("region", { name: "Start an ongoing topic" })).toBeTruthy();
    await screen.findByRole("button", { name: "Follow acme/widgets PRs and CI here" });
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Send my calendar reminders here from now on",
      "Follow acme/widgets PRs and CI here",
      "Help me plan next month's trip, and keep everything about it here",
    ]);
    await userEvent.click(
      screen.getByRole("button", { name: "Send my calendar reminders here from now on" }),
    );
    expect(onStart).toHaveBeenCalledWith("Send my calendar reminders here from now on");
    expect(screen.getByRole("link", { name: "Ask in the main chat →" }).getAttribute("href")).toBe(
      "/chat/concierge",
    );
  });

  it("offers generic topics when nothing is connected, in the guardian's language", async () => {
    await i18n.changeLanguage("zh-CN");
    serve([connector("googlecalendar", null), connector("github", "working")]);
    renderTopic();
    expect(screen.getByRole("region", { name: "开一个长期话题" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "帮我规划下个月的旅行，相关的事都放这里",
      "这里专门管我的健身计划，每周问问我进度",
    ]);
    expect(screen.getByText("只是问个问题？")).toBeTruthy();
    await i18n.changeLanguage("en");
  });
});
