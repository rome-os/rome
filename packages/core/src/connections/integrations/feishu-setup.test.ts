// The Feishu conferral setup, driven through the real SetupSession
// runtime with injected fakes (no network, no SDK long connection).
//
// Seams under test:
//   1. makeFeishuSetup's coroutine — mode/domain prompt → manual credential
//      re-prompt loop OR the agent-ready registerApp dance (QR shown mid-step)
//      → guardian-link wait on the PENDING credential → terminal conferral —
//      observed via the session's poll-able state and the single commit call.
//   2. isFeishuGuardianLinkMessage — the pure link gate: only a sender whose
//      message text is exactly the dashboard code binds.

import { describe, expect, it, rs } from "@rstest/core";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import { isFeishuGuardianLinkMessage, makeFeishuSetup, type FeishuSetupDeps } from "./feishu.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(overrides: Partial<FeishuSetupDeps> = {}): FeishuSetupDeps {
  return {
    probeCredentials: rs.fn(async () => {}),
    registerAgentApp: rs.fn(async () => ({
      appId: "cli_minted",
      appSecret: "minted-secret",
      domain: "feishu" as const,
    })),
    waitForGuardianLink: rs.fn(async () => ({ channelUserId: "ou_guardian" })),
    guardianLinked: rs.fn(async () => false),
    generateCode: rs.fn(() => "246810"),
    ...overrides,
  };
}

describe("makeFeishuSetup (manual mode)", () => {
  it("prompts mode+domain, then credentials, probes, links the guardian, and confers once", async () => {
    const link = deferred<{ channelUserId: string }>();
    const deps = makeDeps({ waitForGuardianLink: rs.fn(() => link.promise) });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit });

    await session.started();
    expect(session.state.status).toBe("awaiting-input");
    if (session.state.status === "awaiting-input") {
      const names = session.state.form.fields.map((f) => f.name);
      expect(names).toEqual(["mode", "domain"]);
    }

    const afterMode = await session.provideInput({ mode: "manual", domain: "lark" });
    expect(afterMode.state.status).toBe("awaiting-input");
    if (afterMode.state.status === "awaiting-input") {
      expect(afterMode.state.form.fields.map((f) => f.name)).toEqual(["appId", "appSecret"]);
    }

    const afterCreds = await session.provideInput({ appId: "cli_abc", appSecret: "shh" });
    expect(deps.probeCredentials).toHaveBeenCalledWith(
      { appId: "cli_abc", appSecret: "shh", domain: "lark" },
      expect.anything(),
    );
    // The link view is server-authored: the code is in the payload so the
    // standard renderer shows it without any Feishu-specific knowledge.
    expect(afterCreds.state.status).toBe("presenting");
    if (afterCreds.state.status === "presenting") {
      expect(afterCreds.state.view.body).toContain("246810");
      expect(afterCreds.state.view.progress).toBe(true);
    }
    expect(deps.waitForGuardianLink).toHaveBeenCalledWith(
      { appId: "cli_abc", appSecret: "shh", domain: "lark" },
      "246810",
      expect.anything(),
    );

    link.resolve({ channelUserId: "ou_guardian" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(commit).toHaveBeenCalledTimes(1);
    const conferral = commit.mock.calls[0][0];
    // Terminal conferral: domain is duplicated into material (adapter build
    // input) AND profile (owner-side identity), atomically.
    expect(conferral.credential).toEqual({
      material: { appId: "cli_abc", appSecret: "shh", domain: "lark", appType: "manual" },
      expiresAt: "never",
    });
    expect(conferral.profile).toEqual({ appId: "cli_abc", domain: "lark", appType: "manual" });
    expect(conferral.guardianChannelUserId).toBe("ou_guardian");
  });

  it("re-prompts the credential form with the error when the probe is refused", async () => {
    const probeCredentials = rs
      .fn<FeishuSetupDeps["probeCredentials"]>()
      .mockRejectedValueOnce(new Error("Invalid App ID or App Secret"))
      .mockResolvedValueOnce(undefined);
    const deps = makeDeps({ probeCredentials });
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit: async () => {} });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "feishu" });

    const rejected = await session.provideInput({ appId: "cli_bad", appSecret: "nope" });
    expect(rejected.state.status).toBe("awaiting-input");
    if (rejected.state.status === "awaiting-input") {
      expect(rejected.state.error).toBe("Invalid App ID or App Secret");
      expect(rejected.state.form.fields.map((f) => f.name)).toEqual(["appId", "appSecret"]);
    }

    const accepted = await session.provideInput({ appId: "cli_ok", appSecret: "yes" });
    expect(accepted.state.status).toBe("presenting");
  });

  it("skips the guardian-link step when the guardian is already mapped", async () => {
    const deps = makeDeps({ guardianLinked: rs.fn(async () => true) });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "feishu" });
    await session.provideInput({ appId: "cli_abc", appSecret: "shh" });

    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(deps.waitForGuardianLink).not.toHaveBeenCalled();
    expect(commit.mock.calls[0][0].guardianChannelUserId).toBeUndefined();
  });
});

describe("makeFeishuSetup (agent-ready mode)", () => {
  it("runs registerApp inside the step, presents the QR mid-wait, then links and confers", async () => {
    const registration = deferred<{
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
    }>();
    let emitQr!: (qr: { url: string; qrDataUrl: string | null; expiresAt: string | null }) => void;
    const registerAgentApp = rs.fn((opts: Parameters<FeishuSetupDeps["registerAgentApp"]>[0]) => {
      emitQr = opts.onQrCode;
      return registration.promise;
    });
    const deps = makeDeps({ registerAgentApp });
    const commit = rs.fn(async (_c: SetupConferral, _s: AbortSignal) => {});
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit });

    await session.started();
    const afterMode = await session.provideInput({ mode: "agent-ready", domain: "feishu" });
    // Before the QR arrives the setup presents its preparing view.
    expect(afterMode.state.status).toBe("presenting");
    expect(registerAgentApp).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "feishu", signal: expect.anything() }),
    );

    // The QR arriving mid-step replaces the presented view; the payload stays
    // semantically complete (url as a labeled link, QR image as a data-url link).
    emitQr({
      url: "https://accounts.feishu.cn/create?x=1",
      qrDataUrl: "data:image/png;base64,QR",
      expiresAt: "2026-07-15T00:10:00.000Z",
    });
    await rs.waitFor(() => {
      expect(session.state.status).toBe("presenting");
      if (session.state.status === "presenting") {
        const urls = (session.state.view.links ?? []).map((l) => l.url);
        expect(urls).toContain("https://accounts.feishu.cn/create?x=1");
        expect(urls).toContain("data:image/png;base64,QR");
      }
    });

    // Scan completes: the SDK minted fresh credentials (tenant resolved lark).
    registration.resolve({ appId: "cli_minted", appSecret: "minted-secret", domain: "lark" });
    await rs.waitFor(() => expect(deps.waitForGuardianLink).toHaveBeenCalled());
    expect(deps.waitForGuardianLink).toHaveBeenCalledWith(
      { appId: "cli_minted", appSecret: "minted-secret", domain: "lark" },
      "246810",
      expect.anything(),
    );

    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    const conferral = commit.mock.calls[0][0];
    expect(conferral.credential).toEqual({
      material: {
        appId: "cli_minted",
        appSecret: "minted-secret",
        domain: "lark",
        appType: "agent_ready",
      },
      expiresAt: "never",
    });
    expect(conferral.profile).toEqual({
      appId: "cli_minted",
      domain: "lark",
      appType: "agent_ready",
    });
  });

  it("interrupts an in-flight registerApp wait on cancel, running no commit", async () => {
    let stepSignal: AbortSignal | undefined;
    const registerAgentApp = rs.fn(
      (opts: Parameters<FeishuSetupDeps["registerAgentApp"]>[0]) =>
        new Promise<{ appId: string; appSecret: string; domain: "feishu" | "lark" }>(
          (_resolve, reject) => {
            stepSignal = opts.signal;
            opts.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          },
        ),
    );
    const deps = makeDeps({ registerAgentApp });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit });
    await session.started();
    await session.provideInput({ mode: "agent-ready", domain: "feishu" });
    expect(session.state.status).toBe("presenting");

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    expect(deps.waitForGuardianLink).not.toHaveBeenCalled();
    expect(stepSignal?.aborted).toBe(true);
  });

  it("interrupts the guardian-link wait on cancel, running no commit", async () => {
    let linkSignal: AbortSignal | undefined;
    const waitForGuardianLink = rs.fn(
      (_m: unknown, _code: string, signal: AbortSignal) =>
        new Promise<{ channelUserId: string }>((_resolve, reject) => {
          linkSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const deps = makeDeps({ waitForGuardianLink });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit });
    await session.started();
    await session.provideInput({ mode: "agent-ready", domain: "lark" });
    await rs.waitFor(() => expect(waitForGuardianLink).toHaveBeenCalled());

    const state = await session.cancel();
    expect(state).toEqual({ status: "cancelled" });
    expect(commit).not.toHaveBeenCalled();
    expect(linkSignal?.aborted).toBe(true);
  });

  it("fails with a guardian-readable reason when registerApp rejects", async () => {
    const registerAgentApp = rs
      .fn<FeishuSetupDeps["registerAgentApp"]>()
      .mockRejectedValue(new Error("QR code expired"));
    const deps = makeDeps({ registerAgentApp });
    const commit = rs.fn(async () => {});
    const session = new SetupSession({ fn: makeFeishuSetup(deps), commit });
    await session.started();
    await session.provideInput({ mode: "agent-ready", domain: "feishu" });

    await rs.waitFor(() => expect(session.state.status).toBe("failed"));
    expect(session.state).toEqual({ status: "failed", reason: "QR code expired" });
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("isFeishuGuardianLinkMessage (guardian-link gate)", () => {
  const code = "555777";

  it("accepts a sender whose message is exactly the code (trimmed)", () => {
    expect(isFeishuGuardianLinkMessage({ senderId: "ou_g", content: "555777" }, code)).toBe(true);
    expect(isFeishuGuardianLinkMessage({ senderId: "ou_g", content: " 555777 " }, code)).toBe(true);
  });

  it("rejects a message without a sender or with the wrong (or no) code", () => {
    expect(isFeishuGuardianLinkMessage({ content: "555777" }, code)).toBe(false);
    expect(isFeishuGuardianLinkMessage({ senderId: "ou_x", content: "hello" }, code)).toBe(false);
    expect(isFeishuGuardianLinkMessage({ senderId: "ou_x", content: "000000" }, code)).toBe(false);
    expect(isFeishuGuardianLinkMessage({ senderId: "ou_x" }, code)).toBe(false);
  });
});
