// @rstest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import type { ChatSession } from "@/lib/chat-types";
import { PinnedModelHint, pinnedHintText } from "./PinnedModelHint";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  rs.restoreAllMocks();
});

const t = i18n.getFixedT("en", "chat");

describe("pinnedHintText", () => {
  it("names the provider a kept chat stays on", () => {
    expect(
      pinnedHintText({ by: "kept", providerId: "openai", selection: null, model: "gpt-6-luna" }, t),
    ).toBe("On ChatGPT");
  });

  it("names the model an owner picked", () => {
    expect(
      pinnedHintText(
        {
          by: "owner",
          providerId: "anthropic",
          selection: "claude-haiku",
          model: "claude-haiku-5-5",
        },
        t,
      ),
    ).toBe("You picked Haiku 5.5");
    // No concrete model yet: the selector's name for the pick.
    expect(
      pinnedHintText(
        { by: "owner", providerId: "anthropic", selection: "claude-haiku", model: null },
        t,
      ),
    ).toBe("You picked Haiku");
  });

  it("reads in Chinese", () => {
    const zh = i18n.getFixedT("zh-CN", "chat");
    expect(
      pinnedHintText({ by: "kept", providerId: "anthropic", selection: null, model: null }, zh),
    ).toBe("在 Claude 上");
  });
});

describe("PinnedModelHint", () => {
  it("follows the default on Back to default and hands back the chat", async () => {
    const followed: ChatSession = {
      id: "s1",
      name: "Trip",
      personaId: null,
      largeModelSelection: null,
      followsDefault: true,
      pinnedModel: null,
    };
    const fetchMock = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation((async () => Response.json(followed)) as typeof fetch);
    const onFollowed = rs.fn();
    render(
      <PinnedModelHint
        sessionId="s1"
        pinnedModel={{ by: "kept", providerId: "openai", selection: null, model: null }}
        onFollowed={onFollowed}
      />,
    );
    expect(screen.getByTestId("pinned-model-hint").textContent).toContain("On ChatGPT ·");
    await userEvent.click(screen.getByRole("button", { name: "Back to default" }));
    await waitFor(() => expect(onFollowed).toHaveBeenCalledWith(followed));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/s1/model/follow-default",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("says so when the server refuses", async () => {
    rs.spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({ error: "Not available" }, { status: 404 })) as typeof fetch);
    const onFollowed = rs.fn();
    render(
      <PinnedModelHint
        sessionId="s1"
        pinnedModel={{
          by: "owner",
          providerId: "anthropic",
          selection: "claude-haiku",
          model: null,
        }}
        onFollowed={onFollowed}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Back to default" }));
    expect(await screen.findByText("Could not change it. Try again.")).toBeTruthy();
    expect(onFollowed).not.toHaveBeenCalled();
  });
});
