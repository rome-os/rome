// Contract check against a REAL signed-in WeChat client in this container.
//
// The unit tests prove Rome reads the shape it expects; only this proves the
// reader helper answers it. The helper reads a vendor's SQLCipher schema
// through a pinned CLI, so the parse is the part most likely to rot — a WeChat
// update can change a chat address or a message kind without touching this repo.
//
// Skipped unless `WECHAT_USER_TEST=1` and a client is installed, signed in, and
// unlocked in this container:
//   WECHAT_USER_TEST=1 pnpm --filter @rome/core test:integration

import { describe, expect, it } from "@rstest/core";
import { WechatUserReader, WechatUserRuntime } from "./wechat-user.js";

const enabled = process.env.WECHAT_USER_TEST === "1";
const withClient = enabled ? describe : describe.skip;

const TIMEOUT_MS = 300_000;

withClient("the WeChat reader contract", () => {
  const runtime = new WechatUserRuntime();
  const reader = new WechatUserReader(runtime);

  it(
    "reads ready status for a signed-in, unlocked account",
    async () => {
      const status = await runtime.status();
      expect(status.installed).toBe(true);
      expect(status.loggedIn).toBe(true);
      expect(status.keysReady).toBe(true);
      expect(status.wxid).toBeTruthy();
    },
    TIMEOUT_MS,
  );

  it(
    "lists real conversations and reads real messages out of one",
    async () => {
      const conversations = await reader.conversations({ limit: 5 });
      expect(conversations.length).toBeGreaterThan(0);

      const chat = conversations.find((c) => c.isGroup) ?? conversations[0]!;
      const messages = await reader.messages({ conversationId: chat.id, limit: 5 });
      expect(messages.length).toBeGreaterThan(0);

      for (const message of messages) {
        expect(message.conversationId).toBe(chat.id);
        expect(message.timestamp).toBeGreaterThan(0);
        // A rich message keeps its placeholder and drops its XML envelope.
        expect(message.text).not.toContain("<?xml");
        expect(message.text.length).toBeLessThanOrEqual(4000);
        // Types are stable tokens, not the CLI's localized labels.
        expect(message.type).toMatch(/^[a-z-]+[a-z0-9-]*$/);
      }
      expect(messages.map((m) => m.timestamp)).toEqual(
        [...messages.map((m) => m.timestamp)].sort((a, b) => a - b),
      );
    },
    TIMEOUT_MS,
  );
});
