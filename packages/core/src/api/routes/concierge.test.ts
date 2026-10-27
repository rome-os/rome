import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import type { ConciergeService } from "../../concierge/service.js";
import { WebChatRepository } from "../../db/repositories/webchat.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { CONCIERGE_UNREAD_CAP, conciergeRoutes } from "./concierge.js";

describe("GET /concierge/session", () => {
  let testDb: TestDb;
  let webchatRepo: WebChatRepository;
  let enabled: boolean;

  const app = () => {
    const concierge = {
      isEnabled: async () => enabled,
      ensureChatId: async () => {
        if (!(await webchatRepo.getSession("concierge"))) {
          await webchatRepo.createSession("concierge", "Concierge");
        }
        return "concierge";
      },
    } as unknown as ConciergeService;
    return new Hono().route("/", conciergeRoutes({ concierge, webchatRepo }));
  };

  beforeEach(() => {
    testDb = createTestDb();
    webchatRepo = new WebChatRepository(testDb.db);
    enabled = true;
    rs.useFakeTimers();
    rs.setSystemTime(new Date("2029-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    rs.useRealTimers();
    testDb.close();
  });

  it("returns the chat with the agent messages it got since the last read", async () => {
    await expect((await app().request("/concierge/session")).json()).resolves.toEqual({
      id: "concierge",
      unread: 0,
    });

    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    await webchatRepo.addBackendMessage("concierge", "turn-1", [{ type: "text", content: "Hi." }]);
    await webchatRepo.addBackendMessage("concierge", "turn-1", [
      { type: "text", content: "Done." },
    ]);
    await expect((await app().request("/concierge/session")).json()).resolves.toEqual({
      id: "concierge",
      unread: 2,
    });

    await webchatRepo.markSessionRead("concierge");
    await expect((await app().request("/concierge/session")).json()).resolves.toEqual({
      id: "concierge",
      unread: 0,
    });
  });

  it("caps the count", async () => {
    await app().request("/concierge/session");
    rs.setSystemTime(new Date("2029-01-01T00:00:01.000Z"));
    for (let index = 0; index <= CONCIERGE_UNREAD_CAP; index += 1) {
      await webchatRepo.addBackendMessage("concierge", "turn-1", [
        { type: "text", content: `${index}` },
      ]);
    }
    const body = (await (await app().request("/concierge/session")).json()) as { unread: number };
    expect(body.unread).toBe(CONCIERGE_UNREAD_CAP);
  });

  it("404s while Concierge is off", async () => {
    enabled = false;
    expect((await app().request("/concierge/session")).status).toBe(404);
  });
});
