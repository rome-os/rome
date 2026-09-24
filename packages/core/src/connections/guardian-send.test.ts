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
import { sendToTarget } from "../people/send.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
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

    const guardianSend = sendToTarget(
      { talkRouter: router },
      { connectionId: connection.id, conversationId: chat },
      "hi",
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

  it("is opened only by people/send.ts", async () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const openers: string[] = [];
    for (const file of await sourceFiles(src)) {
      if (/\.test\.ts$/.test(file) || file.endsWith("guardian-send.ts")) continue;
      if ((await readFile(file, "utf8")).includes("asGuardian")) openers.push(relative(src, file));
    }
    expect(openers).toEqual(["people/send.ts"]);
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
