import { describe, expect, it } from "@rstest/core";
import { createActionEngineRepos } from "../../test/db.js";
import { actionExecutionContext } from "./context.js";
import { ActionEngine } from "./engine.js";
import { ActionRegistryImpl } from "./registry.js";

// The audience main reads for a root run is what a turn the run starts over
// the worker bridge inherits (AgentSessionBridge), so it is kept on the run.
describe("the audience a root run carries", () => {
  function engineWith(firstParty: boolean) {
    const registry = new ActionRegistryImpl();
    registry.register({
      config: {
        // A coordination action's name, so the probe runs in main without a worker.
        name: "core:show_file",
        type: "system",
        description: "Reports the audience its run carries.",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "read-only",
      },
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({
        status: "ok",
        data: actionExecutionContext.getStore()?.audience ?? null,
      }),
    });
    return new ActionEngine(registry, createActionEngineRepos(), {
      processRole: "main",
      isFirstPartyAction: () => firstParty,
      placeAudience: async (context) => (context.threadId === "dm" ? "private" : "shared"),
    });
  }
  const dm = { channel: "telegram", threadId: "dm" };

  it("reads the chat a first-party run names, as for the inbox's message handler", async () => {
    const result = await engineWith(true).run("core:show_file", {}, { channelContext: dm });
    expect(result).toEqual({ status: "ok", data: "private" });
  });

  it("carries none for a run that names no chat", async () => {
    const result = await engineWith(true).run("core:show_file", {});
    expect(result).toEqual({ status: "ok", data: null });
  });

  it("does not read the chat an app's run names, as a detached dispatch does", async () => {
    const result = await engineWith(true).run(
      "core:show_file",
      {},
      { channelContext: dm, callerAppId: "third-party" },
    );
    expect(result).toEqual({ status: "ok", data: null });
  });

  it("keeps an audience the caller states", async () => {
    const result = await engineWith(true).run(
      "core:show_file",
      {},
      { channelContext: dm, audience: "shared" },
    );
    expect(result).toEqual({ status: "ok", data: "shared" });
  });
});
