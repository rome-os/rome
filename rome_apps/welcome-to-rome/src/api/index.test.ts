import type { RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as progressModule from "../db/repositories/progress.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({ reset: rs.fn(), get: rs.fn(), patch: rs.fn() }));

rs.mock("../db/repositories/progress.js", () => ({
  ...progressModule,
  createProgressRepository: () => ({ reset: mocks.reset, get: mocks.get, patch: mocks.patch }),
}));

import { createApiHandler } from "./index.js";

function createContext(): RomeAppContext {
  return {
    app: { id: "welcome-to-rome", version: "0.1.0", description: "Welcome" },
    controller: {},
    db: {} as never,
    log: { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() },
    repositories: { settings: { get: rs.fn(), set: rs.fn(async () => undefined) } },
    runAction: rs.fn(),
    listRoutines: rs.fn(),
  };
}

function resetRequest(locale: unknown): RomeAppApiRequest {
  return {
    method: "POST",
    path: ["reset"],
    headers: {},
    query: new URLSearchParams(),
    caller: { kind: "guardian", userId: "u1", via: "cookie" },
    body: new TextEncoder().encode(JSON.stringify({ locale })),
  };
}

describe("welcome API", () => {
  beforeEach(() => {
    mocks.reset.mockReset();
    mocks.get.mockReset();
    mocks.patch.mockReset();
  });

  it("reports where the welcome run stands and which chat it lives in", async () => {
    mocks.get.mockReturnValue({
      node: "await_question",
      introRawInput: null,
      introSummary: null,
      ideas: [],
      ideasGeneratedAt: null,
      aiConnected: false,
      completedAt: null,
      sessionId: "chat-1",
    });
    const ctx = createContext();

    const response = await createApiHandler(ctx).handle({
      ...resetRequest(undefined),
      method: "GET",
      path: ["state"],
      body: undefined,
    });

    expect(await response.json()).toMatchObject({
      agentName: "Rome",
      progress: {
        node: "await_question",
        aiConnected: false,
        completedAt: null,
        sessionId: "chat-1",
      },
    });
  });

  it("persists the landing locale before resetting the scripted flow", async () => {
    const ctx = createContext();

    const response = await createApiHandler(ctx).handle(resetRequest("zh-CN"));

    expect(response.status).toBe(200);
    expect(ctx.repositories.settings.set).toHaveBeenCalledWith("guardianLanguage", "zh-CN");
    expect(mocks.reset).toHaveBeenCalledOnce();
  });

  it("does not overwrite the language for an unsupported locale", async () => {
    const ctx = createContext();

    await createApiHandler(ctx).handle(resetRequest("zh-TW"));

    expect(ctx.repositories.settings.set).not.toHaveBeenCalled();
    expect(mocks.reset).toHaveBeenCalledOnce();
  });

  describe("POST /session", () => {
    function sessionRequest(body: unknown): RomeAppApiRequest {
      return {
        ...resetRequest(undefined),
        path: ["session"],
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    }

    function run(node: string, sessionId: string | null) {
      mocks.get.mockReturnValue({ node, sessionId });
    }

    it("records the found chat for a run that has none", async () => {
      run("done", null);

      const response = await createApiHandler(createContext()).handle(
        sessionRequest({ sessionId: "chat-9" }),
      );

      expect(await response.json()).toEqual({ ok: true, saved: true });
      expect(mocks.patch).toHaveBeenCalledWith({ sessionId: "chat-9" });
    });

    it("never replaces a recorded chat or touches a run not started", async () => {
      for (const [node, sessionId] of [
        ["await_ai", "chat-1"],
        ["greet", null],
      ] as const) {
        run(node, sessionId);

        const response = await createApiHandler(createContext()).handle(
          sessionRequest({ sessionId: "chat-9" }),
        );

        expect(await response.json()).toEqual({ ok: true, saved: false });
      }
      expect(mocks.patch).not.toHaveBeenCalled();
    });

    it("rejects a missing chat id", async () => {
      const response = await createApiHandler(createContext()).handle(sessionRequest({}));

      expect(response.status).toBe(400);
      expect(mocks.patch).not.toHaveBeenCalled();
    });
  });
});
