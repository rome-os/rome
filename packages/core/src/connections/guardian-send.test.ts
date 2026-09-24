import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConversationId,
  OutgoingMessage,
  TalkFeatureMap,
  TalkFeatureName,
} from "@rome-os/app-runtime";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { Hono, type MiddlewareHandler } from "hono";
import { peopleRoutes } from "../api/routes/people.js";
import { createSession } from "../lib/auth.js";
import {
  runWithSessionActor,
  sessionActorMiddleware,
  type SessionActor,
} from "../lib/session-actor.js";
import { sendToTarget } from "../people/send.js";
import { buildTestDeps, createTestDb, type TestDb } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import { asGuardian, consumeGuardianSend } from "./guardian-send.js";
import { DrizzleGrantLedger } from "./ledger-db.js";
import { ConnectionRegistry } from "./registry.js";
import { tokenPaste } from "./schemes.js";
import { createTalkRouter } from "./talk-router.js";
import type { Talker } from "./types.js";

describe("guardian-send token", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  it("is closed outside asGuardian", () => {
    expect(consumeGuardianSend({ text: "hi" })).toBe(false);
  });

  it("answers true once, only for the message it was opened with", async () => {
    const message = { text: "hi" };
    const seen = await asGuardian(message, async () => {
      const other = consumeGuardianSend({ text: "hi" });
      const first = consumeGuardianSend(message);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [other, first, consumeGuardianSend(message)];
    });
    expect(seen).toEqual([false, true, false]);
  });

  it("closes for work that outlives the call, and when the call throws", async () => {
    const message = { text: "hi" };
    let later: Promise<boolean> | undefined;
    await expect(
      asGuardian(message, async () => {
        later = new Promise((resolve) =>
          setTimeout(() => resolve(consumeGuardianSend(message)), 20),
        );
        throw new Error("talker refused");
      }),
    ).rejects.toThrow("talker refused");
    expect(await later).toBe(false);
  });

  it("passes only the People send through the router, not agent work in flight", async () => {
    testDb = createTestDb();
    const passed: Array<[string, boolean]> = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let spawned: Promise<void> | undefined;
    const talker: Talker = {
      start() {},
      stop() {},
      async send(conversationId, message: OutgoingMessage) {
        const guardian = consumeGuardianSend(message);
        passed.push([message.text ?? "", guardian]);
        if (guardian) {
          // Work the talker kicks off mid-send, e.g. an inbound delivery that
          // produces a pairing notice or an agent reply on this account.
          spawned = router
            .send(connection.id, conversationId, { text: "agent reply" })
            .then(() => undefined);
          await gate;
        }
        return { conversationId, messageId: `m${passed.length}` };
      },
      feature<K extends TalkFeatureName>(): TalkFeatureMap[K] | null {
        return null;
      },
    };
    const registry = new ConnectionRegistry({ ledger: new DrizzleGrantLedger(testDb.db) });
    registry.register({
      service: "wechat_user",
      auth: { session: tokenPaste({ label: "token", validate: async () => {} }) },
      capabilities: { talker: { needs: ["session"], build: () => talker } },
    });
    const connection = await registry.connect("wechat_user");
    await registry.importCredential(connection.id, "session", {
      material: { token: "t" },
      expiresAt: "never",
    });
    const router = createTalkRouter(registry);
    const chat = "wxid_a" as ConversationId;

    const guardianSend = runWithSessionActor(BROWSER_GUARDIAN, () =>
      sendToTarget(
        { talkRouter: router },
        { connectionId: connection.id, conversationId: chat },
        "hi",
      ),
    );
    await rs.waitFor(() => expect(passed).toHaveLength(2));
    await router.send(connection.id, chat, { text: "notice" });
    release();
    await guardianSend;
    await spawned;

    expect(passed).toEqual([
      ["hi", true],
      ["agent reply", false],
      ["notice", false],
    ]);
  });

  it("is reached only through the People routes", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    // Code (not comments) naming each link of the chain, outside tests.
    const users: Record<string, string[]> = {};
    for (const file of await sourceFiles(src)) {
      if (/\.test\.ts$/.test(file)) continue;
      const code = (await readFile(file, "utf8"))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const name of Object.keys(CHAIN)) {
        if (new RegExp(`\\b${name}\\b`).test(code)) {
          (users[name] ??= []).push(relative(src, file));
        }
      }
    }
    for (const name of Object.keys(CHAIN)) users[name]?.sort();
    expect(users).toEqual(CHAIN);
  });
});

/** Each link of the guardian-send chain and the only files whose code names it:
 *  where it is defined, and its one caller. */
const CHAIN: Record<string, string[]> = {
  asGuardian: ["connections/guardian-send.ts", "people/send.ts"],
  sendToTarget: ["people/outbox.ts", "people/send.ts"],
  sendToAccount: ["api/routes/people.ts", "people/outbox.ts"],
  retrySend: ["api/routes/people.ts", "people/outbox.ts"],
};

const BROWSER_GUARDIAN: SessionActor = { kind: "guardian", userId: "guardian", via: "cookie" };

describe("the People send and retry routes", () => {
  let testDb: TestDb | undefined;
  afterEach(() => testDb?.close());

  /**
   * One send through the People routes behind `actor`, then a retry of it.
   * The first provider call fails, so the retry has a row to take. Answers
   * what the talker's token said for each message it was handed.
   */
  async function sendThenRetry(
    actor: (db: TestDb["db"]) => MiddlewareHandler,
    headers: Record<string, string> = {},
  ): Promise<{ retried: number; scoped: boolean[] }> {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    const deps = await buildTestDeps(testDb.db);
    const personId = await deps.personMappingRepo.create({
      displayName: "Send Target",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-1" }],
    });
    const scoped: boolean[] = [];
    const send = deps.talkRouter.send.bind(deps.talkRouter);
    deps.talkRouter.send = async (connectionId, conversationId, message) => {
      scoped.push(consumeGuardianSend(message));
      if (scoped.length === 1) throw new Error("provider rejected");
      return send(connectionId, conversationId, message);
    };
    const app = new Hono().use("*", actor(testDb.db)).route("/", peopleRoutes(deps));
    const person = `/people/${personId}`;
    await app.request(`${person}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ channel: "telegram", channelUserId: "tg-1", text: "hi" }),
    });
    const outbox = (await (await app.request(`${person}/outbox`, { headers })).json()) as {
      messages: Array<{ id: string; state: string }>;
    };
    const failed = outbox.messages.find((row) => row.state === "failed");
    const retried = await app.request(`${person}/outbox/${failed?.id}/retry`, {
      method: "POST",
      headers,
    });
    return { retried: retried.status, scoped };
  }

  it("opens the scope for the guardian's cookie session, on send and retry", async () => {
    const cookie = `rome_session=${createSession("guardian")}`;
    const { retried, scoped } = await sendThenRetry((db) => sessionActorMiddleware(db), {
      cookie,
    });
    expect(retried).toBe(202);
    expect(scoped).toEqual([true, true]);
  });

  it("sends without the scope for a loopback caller, on send and retry", async () => {
    const loopback: SessionActor = { kind: "guardian", userId: "guardian", via: "loopback" };
    const { retried, scoped } = await sendThenRetry(
      () => (_c, next) => runWithSessionActor(loopback, next),
    );
    expect(retried).toBe(202);
    expect(scoped).toEqual([false, false]);
  });

  it("sends without the scope for a request with no session", async () => {
    const { retried, scoped } = await sendThenRetry((db) => sessionActorMiddleware(db));
    expect(retried).toBe(202);
    expect(scoped).toEqual([false, false]);
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) out.push(path);
  }
  return out;
}
