// The WeChat conferral setup (issue #1606), driven through the real
// SetupSession runtime with an injected login-service fake (no ilinkai, no
// network).
//
// Seams under test: makeWechatSetup's coroutine — QR show (data-url payload +
// open link) → `scan-confirmed` poll wait → terminal conferral whose material
// mirrors WECHAT_SETTINGS_IMPORT_ROW (token, baseUrl, accountId duplicated)
// — observed via the session's poll-able state and the single
// commit call. QR refresh loops via repeated `show`; cancel genuinely
// interrupts the in-flight poll wait.

import { describe, expect, it, rs } from "@rstest/core";
import type { WechatSettings } from "../../channels/wechat.js";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral, SetupState } from "../setup/types.js";
import { makeWechatSetup, type WechatLoginService } from "./wechat.js";

const ACCOUNT: WechatSettings = {
  token: "w-tok",
  baseUrl: "https://ilinkai.weixin.qq.com",
  accountId: "acct-1",
  userId: "user-9",
  connectedAt: "2026-07-14T00:00:00.000Z",
  statePath: "/state/wechat",
};

type PollResult = Awaited<ReturnType<WechatLoginService["pollLogin"]>>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A scripted login-service fake: each `startLogin` mints the next attempt
 *  (`qr-1`, `qr-2`, …); each `pollLogin` pops the next scripted status. A
 *  promise entry lets a test hold the loop at an intermediate state until it
 *  has asserted the presented view (the loop is otherwise faster than
 *  `rs.waitFor` can observe). */
function makeAuthFake(script: Array<PollResult | Promise<PollResult>>) {
  let attempts = 0;
  const startLogin = rs.fn(async () => {
    attempts += 1;
    return {
      attemptId: `attempt-${attempts}`,
      qrContent: `qr-content-${attempts}`,
      expiresAt: new Date(0).toISOString(),
    };
  });
  const pollLogin = rs.fn(async (): Promise<PollResult> => script.shift() ?? { status: "wait" });
  const completeLogin = rs.fn();
  return { startLogin, pollLogin, completeLogin };
}

function makeSetupSession(
  auth: WechatLoginService,
  opts: { pollIntervalMs?: number; commit?: (c: SetupConferral) => Promise<void> } = {},
) {
  const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {
    await opts.commit?.(_c);
  });
  const fn = makeWechatSetup({
    auth,
    makeQrDataUrl: async (content) => `data:image/png;qr-of-${content}`,
    pollIntervalMs: opts.pollIntervalMs ?? 1,
  });
  return { session: new SetupSession({ fn, commit }), commit };
}

function presentingView(state: SetupState) {
  expect(state.status).toBe("presenting");
  if (state.status !== "presenting") throw new Error("unreachable");
  return state.view;
}

describe("makeWechatSetup", () => {
  it("shows the QR (data-url payload + open link), then confers on scan confirm", async () => {
    const auth = makeAuthFake([
      { status: "wait" },
      { status: "confirmed", account: { ...ACCOUNT } },
    ]);
    const { session, commit } = makeSetupSession(auth);

    await session.started();
    // The QR is server-rendered into the view payload (semantically complete:
    // any surface shows the image; the raw content rides along as a link).
    const view = presentingView(session.state);
    expect(view.qr).toBe("data:image/png;qr-of-qr-content-1");
    expect(view.links).toEqual([{ label: "Open QR link", url: "qr-content-1" }]);
    expect(view.progress).toBe(true);

    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
    const conferral = commit.mock.calls[0][0];
    // Material parity with WECHAT_SETTINGS_IMPORT_ROW: token + coordinates,
    // accountId duplicated into material; connectedAt stays out.
    expect(conferral.credential).toEqual({
      material: {
        token: "w-tok",
        baseUrl: "https://ilinkai.weixin.qq.com",
        accountId: "acct-1",
        userId: "user-9",
        statePath: "/state/wechat",
      },
      expiresAt: "never",
    });
    expect(conferral.profile).toEqual({ accountId: "acct-1", userId: "user-9" });
    expect(conferral.guardianChannelUserId).toBe("user-9");
    expect(conferral.summary?.title).toBe("WeChat connected");
    // The confirmed attempt is discarded once its account is in the conferral.
    expect(auth.completeLogin).toHaveBeenCalledExactlyOnceWith("attempt-1");
  });

  it("omits the guardian mapping and sparse material fields when the account has no userId", async () => {
    const auth = makeAuthFake([
      {
        status: "confirmed",
        account: { ...ACCOUNT, userId: null, statePath: undefined },
      },
    ]);
    const { session, commit } = makeSetupSession(auth);

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    const conferral = commit.mock.calls[0][0];
    expect(conferral.credential.material).toEqual({
      token: "w-tok",
      baseUrl: "https://ilinkai.weixin.qq.com",
      accountId: "acct-1",
    });
    expect(conferral.profile).toEqual({ accountId: "acct-1" });
    expect(conferral.guardianChannelUserId).toBeUndefined();
  });

  it("marks the scan step done once the provider reports the QR scanned", async () => {
    // The gate holds the poll loop after the `scaned` report so the repainted
    // view is observable before the confirm lands.
    const confirm = deferred<PollResult>();
    const auth = makeAuthFake([{ status: "scaned" }, confirm.promise]);
    const { session } = makeSetupSession(auth);

    await session.started();
    const initial = presentingView(session.state);
    expect(initial.steps).toEqual([
      { text: "Scan the QR code with WeChat" },
      { text: "Confirm the login on your phone" },
    ]);

    await rs.waitFor(() => {
      const view = presentingView(session.state);
      expect(view.steps?.[0]).toEqual({ text: "Scan the QR code with WeChat", done: true });
    });
    confirm.resolve({ status: "confirmed", account: { ...ACCOUNT } });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
  });

  it("refreshes the QR via a repeated show when the attempt expires", async () => {
    const confirm = deferred<PollResult>();
    const auth = makeAuthFake([{ status: "expired" }, confirm.promise]);
    const { session, commit } = makeSetupSession(auth);

    await session.started();
    await rs.waitFor(() => {
      // The second attempt's QR replaces the first in the presented view.
      const view = presentingView(session.state);
      expect(view.qr).toBe("data:image/png;qr-of-qr-content-2");
    });
    confirm.resolve({ status: "confirmed", account: { ...ACCOUNT } });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(auth.startLogin).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(auth.completeLogin).toHaveBeenCalledExactlyOnceWith("attempt-2");
  });

  it("fails (no commit) once the QR refresh budget is exhausted", async () => {
    const auth = makeAuthFake(Array.from({ length: 10 }, () => ({ status: "expired" as const })));
    const { session, commit } = makeSetupSession(auth);

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(session.state).toEqual({
      status: "failed",
      reason: "WeChat QR login expired. Start the setup again.",
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it("interrupts the scan wait promptly on cancel, running no commit", async () => {
    // A huge poll interval: cancel must interrupt the in-flight sleep, not
    // wait it out (the test would time out otherwise).
    const auth = makeAuthFake([{ status: "wait" }]);
    const { session, commit } = makeSetupSession(auth, { pollIntervalMs: 60_000 });

    await session.started();
    await rs.waitFor(() => expect(auth.pollLogin).toHaveBeenCalled());

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    // The poll loop is genuinely dead: no further provider calls trickle in.
    const polls = auth.pollLogin.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(auth.pollLogin).toHaveBeenCalledTimes(polls);
  });

  it("fails the setup when the QR provider is unreachable", async () => {
    const auth = makeAuthFake([]);
    auth.startLogin.mockRejectedValueOnce(new Error("ilinkai unreachable"));
    const { session, commit } = makeSetupSession(auth);

    await session.started();
    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(session.state).toEqual({ status: "failed", reason: "ilinkai unreachable" });
    expect(commit).not.toHaveBeenCalled();
  });
});
