// The Telegram conferral setup, driven through the real
// SetupSession runtime with injected probe fakes (no network, no long-poll), plus
// the real `getUpdates` guardian-link probe driven through grammy's transformer
// seam (a canned wire answer, so no network).
//
// Seams under test:
//   1. makeTelegramSetup's coroutine — prompt → getMe probe → show (one-time
//      code) → getUpdates guardian-link wait → terminal conferral — observed via
//      the session's poll-able state and the single commit call; plus the
//      guardianLinked skip (re-conferral never runs the probe).
//   2. isTelegramGuardianLinkMessage — the pure security gate: only a non-bot
//      author whose message text is exactly the dashboard code binds.
//   3. waitForTelegramGuardianLink — resolves the sender of the code-bearing
//      message; maps a 409 (a live adapter still polling the token) to a
//      guardian-readable failure.

import { describe, expect, it, rs } from "@rstest/core";
import { Bot, type Transformer } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import type { CreateTelegramBot } from "../../channels/telegram.js";
import {
  isTelegramGuardianLinkMessage,
  makeTelegramSetup,
  waitForTelegramGuardianLink,
} from "./telegram.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const BOT_INFO: UserFromGetMe = {
  id: 424242,
  is_bot: true,
  first_name: "SetupBot",
  username: "setup_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

type Answer =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string };

/** A grammy transport fake wired through the transformer seam: getMe answers
 *  from `BOT_INFO`, and each getUpdates call consumes the next canned answer
 *  (a `{ ok: false, error_code }` becomes a real GrammyError inside grammy).
 *  `calls`, when supplied, records each getUpdates payload so a test can assert
 *  the winning-update acknowledgement. */
function fakeBot(
  getUpdatesAnswers: Answer[],
  calls?: Record<string, unknown>[],
): CreateTelegramBot {
  let i = 0;
  return (token: string): Bot => {
    const bot = new Bot(token, { botInfo: BOT_INFO });
    bot.api.config.use(((_prev: unknown, method: string, payload: Record<string, unknown>) => {
      if (method === "getMe") return Promise.resolve({ ok: true, result: BOT_INFO });
      if (method === "getUpdates") {
        calls?.push(payload);
        const answer = getUpdatesAnswers[Math.min(i, getUpdatesAnswers.length - 1)];
        i += 1;
        return Promise.resolve(answer);
      }
      return Promise.resolve({ ok: true, result: true });
    }) as unknown as Transformer);
    return bot;
  };
}

function tgMessage(fromId: number, text: string, isBot = false) {
  return {
    message_id: fromId,
    date: 0,
    chat: { id: fromId, type: "private" },
    from: { id: fromId, is_bot: isBot, first_name: "P" },
    text,
  };
}

describe("makeTelegramSetup", () => {
  it("prompts, probes, shows the one-time code, then confers on guardian link", async () => {
    const link = deferred<{ channelUserId: string }>();
    const probeBotIdentity = rs.fn(async () => ({ botId: "424242", botUsername: "@setup_bot" }));
    const waitForGuardianLink = rs.fn(() => link.promise);
    const guardianLinked = rs.fn(async () => false);
    const generateCode = rs.fn(() => "246810");
    const fn = makeTelegramSetup({
      probeBotIdentity,
      waitForGuardianLink,
      guardianLinked,
      generateCode,
    });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    expect(session.state.status).toBe("awaiting-input");
    // The token prompt carries the server-authored "how to create a bot" guide —
    // numbered steps + the @BotFather link — so the dashboard renders the full
    // setup walkthrough, not just a bare token field.
    if (session.state.status === "awaiting-input") {
      expect(session.state.form.steps?.length).toBeGreaterThan(0);
      expect(session.state.form.links).toEqual([
        { label: "Open @BotFather", url: "https://t.me/BotFather" },
      ]);
    }

    const afterInput = await session.provideInput({ token: "123:abc" });
    expect(probeBotIdentity).toHaveBeenCalledWith("123:abc", expect.anything());
    expect(afterInput.state.status).toBe("presenting");
    if (afterInput.state.status === "presenting") {
      expect(afterInput.state.view.title).toBe("Link your account");
      // The code is server-authored into the view payload so the standard
      // renderer shows it without any Telegram-specific knowledge.
      expect(afterInput.state.view.body).toContain("246810");
      expect(afterInput.state.view.steps).toEqual([
        { text: "Send 246810 to @setup_bot in Telegram" },
      ]);
    }
    // The probe is gated on the exact minted code.
    expect(waitForGuardianLink).toHaveBeenCalledWith("123:abc", "246810", expect.anything());

    link.resolve({ channelUserId: "guardian-777" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual({
      credential: { material: { token: "123:abc" }, expiresAt: "never" },
      profile: { botId: "424242", botUsername: "@setup_bot" },
      guardianChannelUserId: "guardian-777",
      summary: {
        title: "Telegram connected",
        body: ["@setup_bot is live and your account is linked as guardian."],
      },
    });
  });

  it("skips the guardian-link probe when a guardian is already mapped (re-conferral)", async () => {
    const probeBotIdentity = rs.fn(async () => ({ botId: "1", botUsername: "@ok" }));
    const waitForGuardianLink = rs.fn(() => new Promise<{ channelUserId: string }>(() => {}));
    const guardianLinked = rs.fn(async () => true);
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const fn = makeTelegramSetup({
      probeBotIdentity,
      waitForGuardianLink,
      guardianLinked,
      generateCode: () => "000000",
    });
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput({ token: "123:abc" });

    // No getUpdates probe runs (it would 409 against the live adapter); the
    // conferral lands immediately with no guardian mapping in it.
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(waitForGuardianLink).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual({
      credential: { material: { token: "123:abc" }, expiresAt: "never" },
      profile: { botId: "1", botUsername: "@ok" },
      summary: { title: "Telegram connected", body: ["@ok is live."] },
    });
  });

  it("re-prompts with the error when the token probe is refused", async () => {
    const probeBotIdentity = rs
      .fn<(token: string) => Promise<{ botId: string; botUsername: string }>>()
      .mockRejectedValueOnce(new Error("Invalid bot token"))
      .mockResolvedValueOnce({ botId: "1", botUsername: "@ok" });
    const waitForGuardianLink = rs.fn(() => new Promise<{ channelUserId: string }>(() => {}));
    const fn = makeTelegramSetup({
      probeBotIdentity,
      waitForGuardianLink,
      guardianLinked: async () => false,
      generateCode: () => "111111",
    });
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();

    const rejected = await session.provideInput({ token: "bad" });
    expect(rejected.state.status).toBe("awaiting-input");
    if (rejected.state.status !== "awaiting-input") throw new Error("unreachable");
    expect(rejected.state.error).toBe("Invalid bot token");
    expect(rejected.state.form.fields).toEqual([
      { name: "token", label: "Telegram bot token", secret: true },
    ]);
    // The re-prompt still carries the full server-authored setup guide (steps +
    // the @BotFather link), not just the bare field.
    expect(rejected.state.form.steps?.length).toBeGreaterThan(0);
    expect(rejected.state.form.links).toEqual([
      { label: "Open @BotFather", url: "https://t.me/BotFather" },
    ]);

    const accepted = await session.provideInput({ token: "good" });
    expect(accepted.state.status).toBe("presenting");
  });

  it("interrupts the guardian-link wait on cancel, running no commit", async () => {
    const probeBotIdentity = rs.fn(async () => ({ botId: "1", botUsername: "@ok" }));
    let linkSignal: AbortSignal | undefined;
    const waitForGuardianLink = rs.fn(
      (_token: string, _code: string, signal: AbortSignal) =>
        new Promise<{ channelUserId: string }>((_resolve, reject) => {
          linkSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const commit = rs.fn(async () => {});
    const fn = makeTelegramSetup({
      probeBotIdentity,
      waitForGuardianLink,
      guardianLinked: async () => false,
      generateCode: () => "222222",
    });
    const session = new SetupSession({ fn, commit });

    await session.started();
    await session.provideInput({ token: "good" });
    expect(session.state.status).toBe("presenting");

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    expect(linkSignal?.aborted).toBe(true);
  });

  it("interrupts an in-flight token probe on cancel (no re-prompt), running no commit", async () => {
    let probeSignal: AbortSignal | undefined;
    const probeBotIdentity = rs.fn(
      (_token: string, signal?: AbortSignal) =>
        new Promise<{ botId: string; botUsername: string }>((_resolve, reject) => {
          probeSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const waitForGuardianLink = rs.fn(() => new Promise<{ channelUserId: string }>(() => {}));
    const commit = rs.fn(async () => {});
    const fn = makeTelegramSetup({
      probeBotIdentity,
      waitForGuardianLink,
      guardianLinked: async () => false,
      generateCode: () => "333333",
    });
    const session = new SetupSession({ fn, commit });

    await session.started();
    void session.provideInput({ token: "good" });
    await rs.waitFor(() => expect(probeBotIdentity).toHaveBeenCalled());

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    expect(waitForGuardianLink).not.toHaveBeenCalled();
    expect(probeSignal?.aborted).toBe(true);
  });
});

describe("isTelegramGuardianLinkMessage (guardian-link security gate)", () => {
  const code = "555777";

  it("accepts a non-bot author whose message is exactly the code (trimmed)", () => {
    expect(
      isTelegramGuardianLinkMessage({ from: { id: 9, is_bot: false }, text: "555777" }, code),
    ).toBe(true);
    expect(
      isTelegramGuardianLinkMessage({ from: { id: 9, is_bot: false }, text: "  555777 " }, code),
    ).toBe(true);
  });

  it("rejects a bot author even with the right code", () => {
    expect(
      isTelegramGuardianLinkMessage({ from: { id: 9, is_bot: true }, text: "555777" }, code),
    ).toBe(false);
  });

  it("rejects a racing member with the wrong (or no) code", () => {
    expect(
      isTelegramGuardianLinkMessage({ from: { id: 9, is_bot: false }, text: "hello" }, code),
    ).toBe(false);
    expect(
      isTelegramGuardianLinkMessage({ from: { id: 9, is_bot: false }, text: "000000" }, code),
    ).toBe(false);
    expect(isTelegramGuardianLinkMessage({ text: "555777" }, code)).toBe(false);
  });
});

describe("waitForTelegramGuardianLink (getUpdates probe)", () => {
  it("ignores wrong-code messages, resolves the sender, and acks the winning update", async () => {
    const calls: Record<string, unknown>[] = [];
    const createBot = fakeBot(
      [
        { ok: true, result: [{ update_id: 99, message: tgMessage(5, "nope") }] },
        { ok: true, result: [{ update_id: 100, message: tgMessage(7, "123456") }] },
      ],
      calls,
    );
    const controller = new AbortController();
    const result = await waitForTelegramGuardianLink(
      createBot,
      "123:abc",
      "123456",
      controller.signal,
    );
    expect(result).toEqual({ channelUserId: "7" });
    // A final confirming getUpdates acks the winning update (offset 100+1) so
    // Telegram drops it server-side and the live adapter never re-fetches the
    // guardian's code message.
    expect(calls.at(-1)).toMatchObject({ offset: 101, timeout: 0 });
  });

  it("maps a 409 Conflict (a live adapter still polling the token) to a guardian-readable failure", async () => {
    const createBot = fakeBot([
      {
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      },
    ]);
    const controller = new AbortController();
    await expect(
      waitForTelegramGuardianLink(createBot, "123:abc", "123456", controller.signal),
    ).rejects.toThrow(/already connected and running/);
  });

  it("maps a webhook-active 409 to the deleteWebhook remedy, not the disconnect one", async () => {
    const createBot = fakeBot([
      {
        ok: false,
        error_code: 409,
        description: "Conflict: can't use getUpdates method while webhook is active",
      },
    ]);
    const controller = new AbortController();
    await expect(
      waitForTelegramGuardianLink(createBot, "123:abc", "123456", controller.signal),
    ).rejects.toThrow(/webhook/i);
  });
});
