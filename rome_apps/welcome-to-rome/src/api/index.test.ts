import type { RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as progressModule from "../db/repositories/progress.js" with { rstest: "importActual" };

const mocks = rs.hoisted(() => ({ reset: rs.fn() }));

rs.mock("../db/repositories/progress.js", () => ({
  ...progressModule,
  createProgressRepository: () => ({ reset: mocks.reset }),
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
});
