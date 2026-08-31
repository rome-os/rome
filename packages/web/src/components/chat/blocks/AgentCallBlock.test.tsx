// @rstest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "@rstest/core";
import i18n from "@/i18n";
import { AgentCallBlock } from "./AgentCallBlock";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  class TestResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = TestResizeObserver;
});

afterEach(cleanup);

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("AgentCallBlock", () => {
  it("renders a navigable Rome session reference when the live session starts", () => {
    render(
      <MemoryRouter>
        <AgentCallBlock
          agent="reviewer"
          sessionId="runtime-session"
          romeSession={{ _romeSessionId: "action:execution-1:reviewer", _type: "action" }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));

    expect(
      screen.getByRole("link", { name: "action:execution-1:reviewer" }).getAttribute("href"),
    ).toBe("/sessions/action%3Aexecution-1%3Areviewer");
  });

  it("links a webchat Rome session to the chat route", () => {
    render(
      <MemoryRouter>
        <AgentCallBlock
          agent="reviewer"
          sessionId="runtime-session"
          romeSession={{ _romeSessionId: "chat-session-1", _type: "webchat" }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));

    expect(screen.getByRole("link", { name: "chat-session-1" }).getAttribute("href")).toBe(
      "/chat/chat-session-1",
    );
  });

  it("keeps legacy session blocks without a Rome reference link", () => {
    render(
      <MemoryRouter>
        <AgentCallBlock agent="reviewer" sessionId="runtime-session" />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /reviewer/i }));

    expect(screen.queryByRole("link")).toBeNull();
  });
});
