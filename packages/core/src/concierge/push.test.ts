import { describe, expect, it, rs } from "@rstest/core";
import type { SendOutcome, SystemNotifyContent } from "../lib/notify-client.js";

const logged = rs.fn();
rs.mock("../logger.js", () => ({
  createLogger: () => ({ info: logged, warn: logged, error: logged, debug: logged }),
}));

const { ConciergePush, pushBody } = await import("./push.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function pushWith(
  options: {
    quietUntil?: number | null;
    outcome?: () => Promise<SendOutcome>;
    language?: string | null;
    watching?: (chatId: string) => boolean;
  } = {},
) {
  const sent: SystemNotifyContent[] = [];
  const push = new ConciergePush({
    notify: {
      send: async (content) => {
        sent.push(content);
        return (await options.outcome?.()) ?? { kind: "ok", attempted: 1, sent: 1, failed: 0 };
      },
    },
    quietUntil: async () => options.quietUntil ?? null,
    pushesFor: async (chatId) => chatId !== "visitor-chat",
    language: async () => options.language ?? null,
    watching: options.watching,
  });
  return { push, sent };
}

describe("pushBody", () => {
  it("keeps the words of Markdown on one line", () => {
    expect(
      pushBody(
        "# Build\n\n**PR #12** in `acme/widgets` [failed](https://ci.example/1).\n\n- lint\n- tests\n\n> retry?",
      ),
    ).toBe("Build PR #12 in acme/widgets failed. lint tests retry?");
  });

  it("shows characters Markdown escapes as themselves", () => {
    expect(pushBody('Tom & Jerry\'s <draft> "plan"')).toBe('Tom & Jerry\'s "plan"');
    expect(pushBody("`a < b && c`")).toBe("a < b && c");
  });

  it("cuts a long message to about 100 characters, never inside an emoji", () => {
    // The cut lands right after the emoji, so it stays whole.
    expect(pushBody(`${"word ".repeat(19)}ab👩‍👩‍👧 and the rest of it`)).toBe(
      `${"word ".repeat(19)}ab👩‍👩‍👧…`,
    );
    expect(pushBody("short")).toBe("short");
  });
});

describe("ConciergePush", () => {
  it("pushes the first message of a turn with a level, once", async () => {
    const { push, sent } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    push.said({ turnId: "t1", chatId: "c", ownWords: "second", level: "active" });
    push.said({ turnId: "t2", chatId: "c", ownWords: "next turn", level: "passive" });
    await settle();
    expect(sent).toEqual([
      { body: "first", level: "active", chatId: "c" },
      { body: "next turn", level: "passive", chatId: "c" },
    ]);
  });

  it("pushes a fixed line in the guardian's language for a message with none of its own words", async () => {
    for (const [language, line] of [
      ["zh-CN", "有个任务有了新进展"],
      ["en", "A task has an update"],
      [null, "A task has an update"],
      ["constructor", "A task has an update"],
    ] as const) {
      const { push, sent } = pushWith({ language });
      push.said({ turnId: "t1", chatId: "c", ownWords: null, level: "active" });
      await settle();
      expect(sent.map((content) => content.body)).toEqual([line]);
    }
  });

  it("pushes nothing for a turn without a level", async () => {
    const { push, sent } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "hi", level: undefined });
    await settle();
    expect(sent).toEqual([]);
  });

  it("pushes nothing for a chat that is not the guardian's", async () => {
    const { push, sent } = pushWith();
    push.said({ turnId: "t1", chatId: "visitor-chat", ownWords: "hi", level: "active" });
    await settle();
    expect(sent).toEqual([]);
  });

  it("pushes nothing for a chat the guardian's phone shows, proactive or a reply", async () => {
    const { push, sent } = pushWith({ watching: (chatId) => chatId === "open" });
    push.said({ turnId: "t1", chatId: "open", ownWords: "reply", level: "active" });
    push.said({ turnId: "t2", chatId: "open", ownWords: "digest", level: "passive" });
    push.said({ turnId: "t3", chatId: "elsewhere", ownWords: "reply", level: "active" });
    await settle();
    expect(sent).toEqual([{ body: "reply", level: "active", chatId: "elsewhere" }]);
  });

  it("pushes nothing in quiet hours", async () => {
    const { push, sent } = pushWith({ quietUntil: Date.now() + 60_000 });
    push.said({ turnId: "t1", chatId: "c", ownWords: "hi", level: "active" });
    await settle();
    expect(sent).toEqual([]);
  });

  it("never logs the message, whatever the outcome", async () => {
    const secret = "the body text";
    for (const outcome of [
      async (): Promise<SendOutcome> => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }),
      async (): Promise<SendOutcome> => ({ kind: "no_token" }),
      async (): Promise<SendOutcome> => {
        throw new Error("network down");
      },
    ]) {
      const { push } = pushWith({ outcome });
      push.said({ turnId: "t1", chatId: "c", ownWords: secret, level: "active" });
      await settle();
    }
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
  });
});
