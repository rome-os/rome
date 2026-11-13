import { describe, expect, it, rs } from "@rstest/core";
import type { SendOutcome, SystemNotifyContent } from "../instance/notify-client.js";

const logged = rs.fn();
rs.mock("../logger.js", () => ({
  createLogger: () => ({ info: logged, warn: logged, error: logged, debug: logged }),
}));

const { ConciergePush, FIXED_LINE, MERGE_MS, RING_MS, pushBody } = await import("./push.js");
const { currentSessionActor, runWithSessionActor } = await import("../access/session-actor.js");

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const GUARDIAN = "guardian";
const VISITOR = "visitor:acct-v";

/** A push on a fake clock: `advance` moves time and fires the merge timers that fall due. */
function pushWith(
  options: {
    quietUntil?: (owner: string, at: number) => number | null;
    outcome?: () => Promise<SendOutcome>;
    language?: string | null;
    watching?: (owner: string, chatId: string) => boolean;
    dashboardActive?: (owner: string) => boolean;
    ownerOf?: (chatId: string) => Promise<string | null>;
  } = {},
) {
  let now = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const sent: SystemNotifyContent[] = [];
  const push = new ConciergePush({
    notify: {
      send: async (content) => {
        sent.push(content);
        return (await options.outcome?.()) ?? { kind: "ok", attempted: 1, sent: 1, failed: 0 };
      },
    },
    ownerOf:
      options.ownerOf ??
      (async (chatId) => (chatId === "gone" ? null : chatId.startsWith("v-") ? VISITOR : GUARDIAN)),
    quietUntil: async (at, owner) => options.quietUntil?.(owner, at) ?? null,
    language: async () => options.language ?? null,
    watchersOf: (chatId) =>
      new Set([GUARDIAN, VISITOR].filter((owner) => options.watching?.(owner, chatId))),
    activeOwners: () =>
      new Set([GUARDIAN, VISITOR].filter((owner) => options.dashboardActive?.(owner))),
    now: () => now,
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
  });
  const advance = async (ms: number) => {
    // Messages said before the clock moves are handled at the time they were said.
    await settle();
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.fn();
    }
    await settle();
  };
  /** Moves the clock without firing timers, as when a due flush has not run yet. */
  const advanceClock = async (ms: number) => {
    await settle();
    now += ms;
  };
  return { push, sent, advance, advanceClock };
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

  it("shows a pictures block as each picture's title and note, without addresses", () => {
    expect(
      pushBody(
        "Here are two.\n\n```pictures grid\n![Hanauma Bay](https://example.com/a.jpg) Snorkeling\n![Waikiki](/projects/demo/b.png)\n```",
      ),
    ).toBe("Here are two. Hanauma Bay Snorkeling Waikiki");
    expect(pushBody("```pictures list\n![Fuji](https://x.example/a_(1).jpg) Spring\n```")).toBe(
      "Fuji Spring",
    );
  });

  it("leaves another code block as it is", () => {
    expect(pushBody("```ts\nconst a = ![x](https://example.com/a.jpg);\n```")).toBe(
      "const a = ![x](https://example.com/a.jpg);",
    );
    expect(pushBody("```picturesque\n![x](https://example.com/a.jpg)\n```")).toBe(
      "![x](https://example.com/a.jpg)",
    );
    expect(pushBody("```\n![x](https://example.com/a.jpg)\n```")).toBe(
      "![x](https://example.com/a.jpg)",
    );
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
  it("pushes every message of a turn with a level, and nothing for a turn without one", async () => {
    const { push, sent, advance } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await advance(MERGE_MS);
    push.said({ turnId: "t1", chatId: "c", ownWords: "second", level: "active" });
    push.said({ turnId: "t2", chatId: "d", ownWords: "reminder", level: undefined });
    await settle();
    expect(sent.map((content) => content.body)).toEqual(["first", "second"]);
  });

  it("merges messages within 15 s of the chat's last push into one push showing the latest", async () => {
    const { push, sent, advance } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "On it", level: "active" });
    await settle();
    await advance(5_000);
    push.said({ turnId: "t1", chatId: "c", ownWords: "Found two", level: "active" });
    push.said({ turnId: "t1", chatId: "c", ownWords: "Here they are", level: "active" });
    // Another chat has its own window.
    push.said({ turnId: "t2", chatId: "d", ownWords: "Elsewhere", level: "active" });
    await settle();
    expect(sent.map((content) => content.body)).toEqual(["On it", "Elsewhere"]);
    await advance(MERGE_MS - 5_000 - 1);
    expect(sent).toHaveLength(2);
    await advance(1);
    expect(sent.map((content) => content.body)).toEqual(["On it", "Elsewhere", "Here they are"]);
  });

  it("rings only when the chat's last push is more than 2 minutes old, and keeps a passive level passive", async () => {
    const { push, sent, advance } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "one", level: "active" });
    await advance(MERGE_MS);
    push.said({ turnId: "t2", chatId: "c", ownWords: "two", level: "active" });
    await advance(RING_MS);
    push.said({ turnId: "t3", chatId: "c", ownWords: "three", level: "active" });
    await advance(1);
    push.said({ turnId: "t4", chatId: "c", ownWords: "merged", level: "active" });
    await advance(MERGE_MS);
    await advance(RING_MS + 1);
    push.said({ turnId: "t5", chatId: "c", ownWords: "digest", level: "passive" });
    await settle();
    expect(sent.map((content) => [content.body, content.level])).toEqual([
      ["one", "active"],
      ["two", "passive"],
      ["three", "passive"],
      ["merged", "passive"],
      ["digest", "passive"],
    ]);
  });

  it("rings again once the chat has been quiet for over 2 minutes", async () => {
    const { push, sent, advance } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "one", level: "active" });
    await advance(RING_MS + 1);
    push.said({ turnId: "t2", chatId: "c", ownWords: "two", level: "active" });
    await settle();
    expect(sent.map((content) => content.level)).toEqual(["active", "active"]);
  });

  it("pushes the fixed line for a private message, a bare forward or a card", async () => {
    const { push, sent, advance } = pushWith({ language: "zh-CN" });
    push.said({ turnId: "t1", chatId: "c", ownWords: "482913", private: true, level: "active" });
    await advance(MERGE_MS);
    push.said({ turnId: "t1", chatId: "c", ownWords: null, level: "active" });
    await settle();
    expect(sent.map((content) => content.body)).toEqual([FIXED_LINE["zh-CN"], FIXED_LINE["zh-CN"]]);
    expect(JSON.stringify(sent)).not.toContain("482913");
  });

  it("pushes a fixed line in the dashboard's language, English by default", async () => {
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

  it("pushes a visitor's chat to that visitor, and the guardian's with no recipient", async () => {
    const { push, sent } = pushWith();
    push.said({ turnId: "t1", chatId: "v-chat", ownWords: "for the visitor", level: "active" });
    push.said({ turnId: "t2", chatId: "c", ownWords: "for the guardian", level: "active" });
    push.said({ turnId: "t3", chatId: "gone", ownWords: "nobody", level: "active" });
    await settle();
    expect(sent).toEqual([
      { body: "for the visitor", level: "active", chatId: "v-chat", recipient: "acct-v" },
      { body: "for the guardian", level: "active", chatId: "c" },
    ]);
  });

  it("pushes nothing for a chat its owner's phone shows, and the next message after it leaves pushes", async () => {
    let shown = true;
    const { push, sent } = pushWith({
      watching: (owner, chatId) => shown && owner === GUARDIAN && chatId === "c",
    });
    push.said({ turnId: "t1", chatId: "c", ownWords: "read on screen", level: "active" });
    push.said({ turnId: "t2", chatId: "elsewhere", ownWords: "other chat", level: "active" });
    await settle();
    shown = false;
    push.said({ turnId: "t1", chatId: "c", ownWords: "after leaving", level: "active" });
    await settle();
    expect(sent.map((content) => content.body)).toEqual(["other chat", "after leaving"]);
  });

  it("holds back only the active person's pushes while their dashboard is active, and logs it", async () => {
    let active = true;
    const { push, sent, advance } = pushWith({
      dashboardActive: (owner) => active && owner === GUARDIAN,
    });
    logged.mockClear();
    push.said({ turnId: "t1", chatId: "a", ownWords: "reply", level: "active" });
    push.said({ turnId: "t2", chatId: "b", ownWords: "digest", level: "passive" });
    push.said({ turnId: "t3", chatId: "v-chat", ownWords: "visitor's", level: "active" });
    await settle();
    expect(sent.map((content) => content.body)).toEqual(["visitor's"]);
    expect(logged).toHaveBeenCalledWith("concierge push held back: a dashboard is active", {
      turnId: "t1",
      chatId: "a",
    });
    expect(JSON.stringify(logged.mock.calls)).not.toContain("reply");
    // Nothing held back pushes once the dashboard goes idle; the next message does.
    active = false;
    await advance(MERGE_MS);
    expect(sent).toHaveLength(1);
    push.said({ turnId: "t4", chatId: "a", ownWords: "later", level: "active" });
    await settle();
    expect(sent.at(-1)).toEqual({ body: "later", level: "active", chatId: "a" });
  });

  it("drops a message held when said, even when the hold clears before its window ends", async () => {
    let active = false;
    const { push, sent, advance } = pushWith({ dashboardActive: () => active });
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await settle();
    active = true;
    push.said({ turnId: "t1", chatId: "c", ownWords: "read at the dashboard", level: "active" });
    await settle();
    active = false;
    await advance(MERGE_MS);
    await advance(MERGE_MS);
    expect(sent.map((content) => content.body)).toEqual(["first"]);
  });

  it("drops a message held when said even when the hold ends before its owner is known", async () => {
    let active = true;
    let release: () => void = () => {};
    const { push, sent, advance } = pushWith({
      dashboardActive: () => active,
      ownerOf: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return GUARDIAN;
      },
    });
    push.said({ turnId: "t1", chatId: "c", ownWords: "read at the dashboard", level: "active" });
    // The dashboard goes idle while the owner lookup is still out.
    active = false;
    release();
    await advance(MERGE_MS);
    expect(sent).toEqual([]);
  });

  it("drops a message said in quiet hours even when they end before its owner is known", async () => {
    let release: () => void = () => {};
    const quietEnds = 1_000_000 + 1_000;
    const { push, sent, advance, advanceClock } = pushWith({
      quietUntil: (_owner, at) => (at < quietEnds ? quietEnds : null),
      ownerOf: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return GUARDIAN;
      },
    });
    push.said({ turnId: "t1", chatId: "c", ownWords: "said at night", level: "active" });
    // Quiet hours end while the owner lookup is still out.
    await advanceClock(2_000);
    release();
    await advance(MERGE_MS);
    expect(sent).toEqual([]);
  });

  it("drops a message said while the phone shows the chat, even after the phone leaves", async () => {
    let shown = false;
    const { push, sent, advance } = pushWith({ watching: () => shown });
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await settle();
    shown = true;
    push.said({ turnId: "t1", chatId: "c", ownWords: "read on the phone", level: "active" });
    await settle();
    shown = false;
    await advance(MERGE_MS);
    expect(sent.map((content) => content.body)).toEqual(["first"]);
  });

  it("never sends a pending message after a newer one handled past the window's end", async () => {
    const { push, sent, advance, advanceClock } = pushWith();
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await advanceClock(5_000);
    push.said({ turnId: "t1", chatId: "c", ownWords: "older", level: "active" });
    // The window ends, but its flush has not run yet.
    await advanceClock(MERGE_MS);
    push.said({ turnId: "t1", chatId: "c", ownWords: "newer", level: "active" });
    await settle();
    await advance(0);
    await advance(MERGE_MS);
    expect(sent.map((content) => content.body)).toEqual(["first", "newer"]);
  });

  it("keeps the newest message when its owner lookup straddles the window's end", async () => {
    const waiting: Array<() => void> = [];
    let slow = false;
    const { push, sent, advance, advanceClock } = pushWith({
      ownerOf: async () => {
        if (slow) await new Promise<void>((resolve) => waiting.push(resolve));
        return GUARDIAN;
      },
    });
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await advanceClock(5_000);
    push.said({ turnId: "t1", chatId: "c", ownWords: "older", level: "active" });
    await advanceClock(8_000);
    slow = true;
    push.said({ turnId: "t1", chatId: "c", ownWords: "newer", level: "active" });
    push.said({ turnId: "t1", chatId: "c", ownWords: "C", level: "active" });
    // The window ends and its flush fires while both lookups are still out.
    await advance(MERGE_MS);
    slow = false;
    for (const resolve of waiting.splice(0)) resolve();
    await settle();
    // "newer" opened a new window, and C waits in it: the first window's
    // late flush neither sends "older" nor takes C early.
    expect(sent.map((content) => content.body)).toEqual(["first", "newer"]);
    await advance(MERGE_MS);
    expect(sent.map((content) => content.body)).toEqual(["first", "newer", "C"]);
  });

  it("drops a merged push that a hold covers when its window ends", async () => {
    let active = false;
    const { push, sent, advance } = pushWith({ dashboardActive: () => active });
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await settle();
    push.said({ turnId: "t1", chatId: "c", ownWords: "merged", level: "active" });
    active = true;
    await advance(MERGE_MS);
    active = false;
    await advance(MERGE_MS);
    expect(sent.map((content) => content.body)).toEqual(["first"]);
  });

  it("holds back a push in its owner's quiet hours only", async () => {
    const { push, sent } = pushWith({
      quietUntil: (owner) => (owner === VISITOR ? 1_000_000 + 60_000 : null),
    });
    push.said({ turnId: "t1", chatId: "v-chat", ownWords: "quiet", level: "active" });
    push.said({ turnId: "t2", chatId: "c", ownWords: "not quiet", level: "active" });
    await settle();
    expect(sent.map((content) => content.body)).toEqual(["not quiet"]);
  });

  it("never holds a chat's later message on a send still in flight", async () => {
    const { push, sent, advance } = pushWith({ outcome: () => new Promise(() => {}) });
    push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
    await advance(MERGE_MS);
    push.said({ turnId: "t2", chatId: "c", ownWords: "second", level: "active" });
    await settle();
    expect(sent.map((content) => content.body)).toEqual(["first", "second"]);
  });

  it("sends and arms its merge timer as no one, whichever person's turn said the message", async () => {
    const sendActors: unknown[] = [];
    const timerActors: Array<Promise<unknown>> = [];
    const push = new ConciergePush({
      notify: {
        send: async () => {
          sendActors.push(await currentSessionActor());
          return { kind: "ok", attempted: 1, sent: 1, failed: 0 };
        },
      },
      ownerOf: async () => GUARDIAN,
      quietUntil: async () => null,
      language: async () => null,
      now: () => 1_000_000,
      setTimer: () => {
        timerActors.push(currentSessionActor());
      },
    });
    const visitor = { kind: "visitor" as const, accountId: "acct-v", email: "v@example.com" };
    runWithSessionActor(visitor, () => {
      push.said({ turnId: "t1", chatId: "c", ownWords: "first", level: "active" });
      push.said({ turnId: "t1", chatId: "c", ownWords: "merged", level: "active" });
    });
    await settle();
    expect(sendActors).toEqual([undefined]);
    expect(await Promise.all(timerActors)).toEqual([undefined]);
  });

  it("never logs the message, whatever the outcome", async () => {
    const secret = "the body text";
    for (const outcome of [
      async (): Promise<SendOutcome> => ({ kind: "ok", attempted: 1, sent: 1, failed: 0 }),
      async (): Promise<SendOutcome> => ({ kind: "no_token" }),
      async (): Promise<SendOutcome> => ({ kind: "outcome_unknown" }),
      async (): Promise<SendOutcome> => ({ kind: "not_hosted" }),
      async (): Promise<SendOutcome> => {
        throw new Error("network down");
      },
    ]) {
      const { push } = pushWith({ outcome });
      push.said({ turnId: "t1", chatId: "v-chat", ownWords: secret, level: "active" });
      await settle();
    }
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("acct-v");
  });
});
