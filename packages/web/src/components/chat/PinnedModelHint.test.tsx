// @rstest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, rs } from "@rstest/core";
import i18n from "@/i18n";
import type { ChatSession } from "@/lib/chat-types";
import { PinnedModelHint, backToDefaultBody, pinnedHintText } from "./PinnedModelHint";

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
          selection: "anthropic/claude-haiku-5-5",
          model: "claude-haiku-5-5",
        },
        t,
      ),
    ).toBe("You picked Haiku 5.5");
    // No concrete model yet: the selector's name for the pick.
    expect(
      pinnedHintText(
        {
          by: "owner",
          providerId: "anthropic",
          selection: "anthropic/claude-haiku-5-5",
          model: null,
        },
        t,
      ),
    ).toBe("You picked Haiku 5.5");
  });

  it("reads in Chinese", () => {
    const zh = i18n.getFixedT("zh-CN", "chat");
    expect(
      pinnedHintText({ by: "kept", providerId: "anthropic", selection: null, model: null }, zh),
    ).toBe("在 Claude 上");
  });
});

describe("backToDefaultBody", () => {
  it("says where a kept chat moves", () => {
    expect(
      backToDefaultBody(
        { by: "kept", providerId: "anthropic", selection: null, model: null },
        "openai",
        t,
      ),
    ).toBe("This chat moves from Claude to ChatGPT, your default, from its next reply.");
  });

  it("says an owner's pick stops", () => {
    expect(
      backToDefaultBody(
        {
          by: "owner",
          providerId: "anthropic",
          selection: "anthropic/claude-haiku-5-5",
          model: "claude-haiku-5-5",
        },
        "openai",
        t,
      ),
    ).toBe(
      "This chat stops using Haiku 5.5 and follows your default, ChatGPT, from its next reply.",
    );
  });
});

/** Answers the default read with ChatGPT, and follow-default with `followed`. */
function mockApi(followed: Response) {
  return rs.spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    if (String(input).endsWith("/api/ai-tools/default")) {
      return Response.json({
        defaultProvider: {
          provider: "openai",
          signedIn: { anthropic: true, openai: true, rome_credits: false },
        },
      });
    }
    return followed.clone();
  }) as typeof fetch);
}

function renderHint(pinnedModel: NonNullable<ChatSession["pinnedModel"]>, onFollowed: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PinnedModelHint sessionId="s1" pinnedModel={pinnedModel} onFollowed={onFollowed} />
    </QueryClientProvider>,
  );
}

describe("PinnedModelHint", () => {
  it("asks first, then follows the default and hands back the chat", async () => {
    const followed: ChatSession = {
      id: "s1",
      name: "Trip",
      largeModelSelection: null,
      followsDefault: true,
      pinnedModel: null,
    };
    const fetchMock = mockApi(Response.json(followed));
    const onFollowed = rs.fn();
    renderHint({ by: "kept", providerId: "anthropic", selection: null, model: null }, onFollowed);
    expect(screen.getByTestId("pinned-model-hint").textContent).toContain("On Claude ·");
    await userEvent.click(screen.getByRole("button", { name: "Back to default" }));
    const dialog = await screen.findByRole("dialog", { name: "Back to the default?" });
    await waitFor(() =>
      expect(dialog.textContent).toContain(
        "This chat moves from Claude to ChatGPT, your default, from its next reply.",
      ),
    );
    expect(onFollowed).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to default" }));
    await waitFor(() => expect(onFollowed).toHaveBeenCalledWith(followed));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat/sessions/s1/model/follow-default",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does nothing on Cancel", async () => {
    const fetchMock = mockApi(Response.json({}));
    const onFollowed = rs.fn();
    renderHint({ by: "kept", providerId: "anthropic", selection: null, model: null }, onFollowed);
    await userEvent.click(screen.getByRole("button", { name: "Back to default" }));
    const dialog = await screen.findByRole("dialog", { name: "Back to the default?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onFollowed).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("follow-default"))).toBe(
      false,
    );
  });

  it("says so when the server refuses", async () => {
    mockApi(Response.json({ error: "Not available" }, { status: 404 }));
    const onFollowed = rs.fn();
    renderHint(
      {
        by: "owner",
        providerId: "anthropic",
        selection: "anthropic/claude-haiku-5-5",
        model: null,
      },
      onFollowed,
    );
    await userEvent.click(screen.getByRole("button", { name: "Back to default" }));
    const dialog = await screen.findByRole("dialog", { name: "Back to the default?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Back to default" }));
    expect(await screen.findByText("Could not change it. Try again.")).toBeTruthy();
    expect(onFollowed).not.toHaveBeenCalled();
  });
});
