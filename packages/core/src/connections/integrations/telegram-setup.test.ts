import { describe, expect, it, rs } from "@rstest/core";
import { SetupSession } from "../setup/session.js";
import type { SetupConferral } from "../setup/types.js";
import { makeTelegramSetup } from "./telegram.js";

describe("telegram credential setup", () => {
  it("confers validated credentials without consuming inbound messages or mapping an account", async () => {
    const probeBotIdentity = rs.fn(async () => ({ botId: "42", botUsername: "rome_bot" }));
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({ fn: makeTelegramSetup({ probeBotIdentity }), commit });
    await session.started();
    expect(session.state.status).toBe("awaiting-input");
    await session.provideInput({ token: "good-token" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
    expect(probeBotIdentity).toHaveBeenCalledWith("good-token", expect.anything());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toMatchObject({
      credential: { material: { token: "good-token" } },
    });
    expect(commit.mock.calls[0][0]).not.toHaveProperty("guardianChannelUserId");
  });

  it("re-prompts a refused token and allows retry", async () => {
    const probeBotIdentity = rs.fn(async (token: string) => {
      if (token === "bad") throw new Error("Invalid token");
      return { botId: "42", botUsername: "rome_bot" };
    });
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({ fn: makeTelegramSetup({ probeBotIdentity }), commit });
    await session.started();
    await session.provideInput({ token: "bad" });
    expect(session.state.status).toBe("awaiting-input");
    expect(commit).not.toHaveBeenCalled();
    await session.provideInput({ token: "good" });
    await rs.waitFor(() => expect(session.state.status).toBe("done"));
  });

  it("cancels an in-flight probe without writing credentials", async () => {
    const probeBotIdentity = rs.fn(
      (_token: string, signal?: AbortSignal) =>
        new Promise<{ botId: string; botUsername: string }>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    const commit = rs.fn(async (_value: SetupConferral) => {});
    const session = new SetupSession({ fn: makeTelegramSetup({ probeBotIdentity }), commit });
    await session.started();
    const input = session.provideInput({ token: "good" });
    await rs.waitFor(() => expect(probeBotIdentity).toHaveBeenCalled());
    await session.cancel();
    await input;
    expect(commit).not.toHaveBeenCalled();
  });
});
