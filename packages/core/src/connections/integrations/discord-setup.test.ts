// The Discord conferral setup, driven through the real
// SetupSession runtime with injected probe fakes (no network, no gateway).
//
// Seams under test:
//   1. makeDiscordSetup's coroutine — prompt → probe → show (one-time code) →
//      guardian-link wait → terminal conferral — observed via the session's
//      poll-able state and the single commit call.
//   2. isGuardianLinkMessage — the pure security gate (finding #1): only a
//      non-bot author whose message text is exactly the dashboard code binds.

import { describe, expect, it, rs } from "@rstest/core";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import { isGuardianLinkMessage, makeDiscordSetup } from "./discord.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("makeDiscordSetup", () => {
  it("prompts, probes, shows the one-time code, then confers on guardian link", async () => {
    const link = deferred<{ channelUserId: string }>();
    const probeBotIdentity = rs.fn(async () => ({ botId: "42", botUsername: "rome_bot" }));
    const waitForGuardianLink = rs.fn(() => link.promise);
    const generateCode = rs.fn(() => "246810");
    const fn = makeDiscordSetup({ probeBotIdentity, waitForGuardianLink, generateCode });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn, commit });

    await session.started();
    expect(session.state.status).toBe("awaiting-input");
    // The token prompt carries the server-authored "how to create a bot" guide —
    // numbered steps + the Developer Portal link — so the dashboard renders the
    // full setup walkthrough, not just a bare token field.
    if (session.state.status === "awaiting-input") {
      expect(session.state.form.steps?.length).toBeGreaterThan(0);
      expect(session.state.form.links).toEqual([
        {
          label: "Open the Discord Developer Portal",
          url: "https://discord.com/developers/applications",
        },
      ]);
      // The trailing note carries the "View Channels" troubleshooting aside.
      expect(session.state.form.note).toContain("View Channels");
    }

    const afterInput = await session.provideInput({ token: "good-token" });
    expect(probeBotIdentity).toHaveBeenCalledWith("good-token", expect.anything());
    expect(afterInput.state.status).toBe("presenting");
    if (afterInput.state.status === "presenting") {
      expect(afterInput.state.view.title).toBe("Link your account");
      // The code is server-authored into the view payload so the standard
      // renderer shows it without any Discord-specific knowledge.
      expect(afterInput.state.view.body).toContain("246810");
      expect(afterInput.state.view.steps).toEqual([{ text: "Send 246810 to your bot in Discord" }]);
    }
    // The probe is gated on the exact minted code.
    expect(waitForGuardianLink).toHaveBeenCalledWith("good-token", "246810", expect.anything());

    link.resolve({ channelUserId: "guardian-777" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual({
      credential: { material: { token: "good-token" }, expiresAt: "never" },
      profile: { botId: "42", botUsername: "rome_bot" },
      guardianChannelUserId: "guardian-777",
      summary: {
        title: "Discord connected",
        body: ["@rome_bot is live and your account is linked as guardian."],
      },
    });
  });

  it("re-prompts with the error when the token probe is refused", async () => {
    const probeBotIdentity = rs
      .fn<(token: string) => Promise<{ botId: string; botUsername: string }>>()
      .mockRejectedValueOnce(new Error("Invalid bot token — check the Discord Developer Portal"))
      .mockResolvedValueOnce({ botId: "1", botUsername: "ok" });
    const waitForGuardianLink = rs.fn(() => new Promise<{ channelUserId: string }>(() => {}));
    const fn = makeDiscordSetup({
      probeBotIdentity,
      waitForGuardianLink,
      generateCode: () => "111111",
    });
    const session = new SetupSession({ fn, commit: async () => {} });
    await session.started();

    const rejected = await session.provideInput({ token: "bad" });
    expect(rejected.state.status).toBe("awaiting-input");
    if (rejected.state.status !== "awaiting-input") throw new Error("unreachable");
    expect(rejected.state.error).toBe("Invalid bot token — check the Discord Developer Portal");
    expect(rejected.state.form.fields).toEqual([
      { name: "token", label: "Discord bot token", secret: true },
    ]);
    // The re-prompt still carries the full server-authored setup guide (steps +
    // the Developer Portal link), not just the bare field.
    expect(rejected.state.form.steps?.length).toBeGreaterThan(0);
    expect(rejected.state.form.links).toEqual([
      {
        label: "Open the Discord Developer Portal",
        url: "https://discord.com/developers/applications",
      },
    ]);

    const accepted = await session.provideInput({ token: "good" });
    expect(accepted.state.status).toBe("presenting");
  });

  it("interrupts the guardian-link wait on cancel, running no commit", async () => {
    const probeBotIdentity = rs.fn(async () => ({ botId: "1", botUsername: "ok" }));
    let linkSignal: AbortSignal | undefined;
    const waitForGuardianLink = rs.fn(
      (_token: string, _code: string, signal: AbortSignal) =>
        new Promise<{ channelUserId: string }>((_resolve, reject) => {
          linkSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const commit = rs.fn(async () => {});
    const fn = makeDiscordSetup({
      probeBotIdentity,
      waitForGuardianLink,
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
    const fn = makeDiscordSetup({
      probeBotIdentity,
      waitForGuardianLink,
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

describe("isGuardianLinkMessage (guardian-link security gate)", () => {
  const code = "555777";

  it("accepts a non-bot author whose message is exactly the code (trimmed)", () => {
    expect(
      isGuardianLinkMessage({ author: { id: "g", bot: false }, content: "555777" }, code),
    ).toBe(true);
    expect(
      isGuardianLinkMessage({ author: { id: "g", bot: false }, content: "  555777 " }, code),
    ).toBe(true);
  });

  it("rejects a bot author even with the right code", () => {
    expect(isGuardianLinkMessage({ author: { id: "b", bot: true }, content: "555777" }, code)).toBe(
      false,
    );
  });

  it("rejects a racing member with the wrong (or no) code", () => {
    expect(isGuardianLinkMessage({ author: { id: "x", bot: false }, content: "hello" }, code)).toBe(
      false,
    );
    expect(
      isGuardianLinkMessage({ author: { id: "x", bot: false }, content: "000000" }, code),
    ).toBe(false);
    expect(isGuardianLinkMessage({ content: "555777" }, code)).toBe(false);
  });
});
