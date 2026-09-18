import { describe, expect, it, rs } from "@rstest/core";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import { makeFeishuSetup } from "./feishu.js";

describe("Feishu credential setup", () => {
  it("validates manual credentials and confers without granting guardian authority", async () => {
    const probeCredentials = rs.fn(async () => {});
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({
        probeCredentials,
        registerAgentApp: async () => {
          throw new Error("Unexpected QR setup");
        },
      }),
      commit,
    });
    await session.started();
    await session.provideInput({ mode: "manual", domain: "lark" });
    await session.provideInput({ appId: "app", appSecret: "secret" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(probeCredentials).toHaveBeenCalledWith(
      { appId: "app", appSecret: "secret", domain: "lark" },
      expect.anything(),
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).not.toHaveProperty("guardianChannelUserId");
  });

  it("keeps QR registration cancellable with no durable write", async () => {
    const registerAgentApp = rs.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({
      fn: makeFeishuSetup({ probeCredentials: async () => {}, registerAgentApp }),
      commit,
    });
    await session.started();
    const input = session.provideInput({ mode: "agent-ready", domain: "feishu" });
    await rs.waitFor(() => expect(registerAgentApp).toHaveBeenCalled());
    await session.cancel();
    await input;
    expect(commit).not.toHaveBeenCalled();
  });
});
