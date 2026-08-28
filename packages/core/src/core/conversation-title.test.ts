import { describe, expect, it, rs } from "@rstest/core";
import type { ModelProvider, ModelSession, ModelSessionParams } from "./agent-runner.js";
import {
  CONVERSATION_TITLE_INPUT_MAX_LENGTH,
  conversationTitleLength,
  createConversationTitleGenerator,
  fallbackConversationTitle,
  normalizeConversationTitle,
} from "./conversation-title.js";
import type { ModelResolver } from "./model-resolver.js";

function resultSession(content: string): ModelSession {
  return {
    providerId: "mock",
    model: "small-model",
    events: (async function* () {
      yield { type: "result" as const, content };
    })(),
    sendUserInput: rs.fn(async () => undefined),
    fork: rs.fn(async () => {
      throw new Error("not supported");
    }),
    interrupt: rs.fn(async () => undefined),
    close: rs.fn(async () => undefined),
  };
}

describe("conversation title generation", () => {
  it("uses an isolated small model and returns its concise title", async () => {
    const session = resultSession('  "Q4 launch planning"  ');
    let openParams: ModelSessionParams | undefined;
    const provider: ModelProvider = {
      id: "mock",
      displayName: "Mock",
      builtinTools: new Set(),
      openSession: rs.fn(async (params) => {
        openParams = params;
        return session;
      }),
    };
    const modelResolver: ModelResolver = {
      getModelProvider: rs.fn(async () => ({ modelProvider: provider, model: "small-model" })),
    };

    const title = await createConversationTitleGenerator(modelResolver).generate(
      "Could you help me build a detailed launch plan for Q4?",
    );

    expect(title).toBe("Q4 launch planning");
    expect(modelResolver.getModelProvider).toHaveBeenCalledWith({ tier: "small" });
    expect(openParams).toMatchObject({
      model: "small-model",
      agentName: "conversation-title",
      builtinTools: [],
      maxTurns: 1,
      reasoningEffort: "low",
      isNewSession: true,
    });
    expect(openParams?.getActionCatalog()).toEqual([]);
    expect(openParams?.getSkillCatalog()).toEqual([]);
    expect(session.sendUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          JSON.stringify("Could you help me build a detailed launch plan for Q4?"),
        ),
      }),
    );
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("normalizes model formatting and keeps Unicode titles within 50 characters", () => {
    expect(normalizeConversationTitle("Title:  Weekly   meal\nplanning. ")).toBe(
      "Weekly meal planning",
    );
    const family = "👨‍👩‍👧";
    expect(normalizeConversationTitle(family.repeat(60))).toBe(`${family.repeat(49)}…`);
    expect(conversationTitleLength(normalizeConversationTitle(family.repeat(60)) ?? "")).toBe(50);
  });

  it("provides a readable first-message fallback when title generation fails", () => {
    expect(fallbackConversationTitle("  Plan   a launch\nfor Q4  ")).toBe("Plan a launch for Q4");
  });

  it("bounds the first-message text sent to the title model", async () => {
    const session = resultSession("Bounded title");
    const provider: ModelProvider = {
      id: "mock",
      displayName: "Mock",
      builtinTools: new Set(),
      openSession: rs.fn(async () => session),
    };
    const modelResolver: ModelResolver = {
      getModelProvider: rs.fn(async () => ({ modelProvider: provider, model: "small-model" })),
    };
    const firstMessage = `${"a".repeat(CONVERSATION_TITLE_INPUT_MAX_LENGTH)}SHOULD_NOT_APPEAR`;

    await createConversationTitleGenerator(modelResolver).generate(firstMessage);

    expect(session.sendUserInput).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          JSON.stringify(`${"a".repeat(CONVERSATION_TITLE_INPUT_MAX_LENGTH - 1)}…`),
        ),
      }),
    );
    expect(rs.mocked(session.sendUserInput).mock.calls[0]?.[0].text).not.toContain(
      "SHOULD_NOT_APPEAR",
    );
  });

  it("closes a model session that opens after the generation timeout", async () => {
    rs.useFakeTimers();
    try {
      const session = resultSession("Too late");
      let resolveOpen!: (session: ModelSession) => void;
      const openSession = rs.fn(
        () =>
          new Promise<ModelSession>((resolve) => {
            resolveOpen = resolve;
          }),
      );
      const provider: ModelProvider = {
        id: "mock",
        displayName: "Mock",
        builtinTools: new Set(),
        openSession,
      };
      const modelResolver: ModelResolver = {
        getModelProvider: rs.fn(async () => ({ modelProvider: provider, model: "small-model" })),
      };
      const pending = createConversationTitleGenerator(modelResolver, { timeoutMs: 10 }).generate(
        "Name this chat",
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(openSession).toHaveBeenCalledOnce();

      const rejection = expect(pending).rejects.toThrow("timed out");
      await rs.advanceTimersByTimeAsync(10);
      await rejection;

      resolveOpen(session);
      await rs.waitFor(() => expect(session.close).toHaveBeenCalledOnce());
      expect(session.sendUserInput).not.toHaveBeenCalled();
    } finally {
      rs.useRealTimers();
    }
  });
});
