import { describe, expect, it } from "@rstest/core";
import { PiRuntimeManager, type PiModelRuntime } from "./pi-runtime.js";

describe("PiRuntimeManager", () => {
  it("discovers authenticated models under qualified identities", async () => {
    const available = [
      { provider: "openai", id: "shared", name: "Shared", input: ["text"] },
      { provider: "custom", id: "shared", name: "Custom Shared", input: ["text"] },
      { provider: "media", id: "image-only", name: "Image", input: ["image"] },
    ] as never;
    const runtime: PiModelRuntime = {
      getAvailable: async () => available,
    };
    const manager = new PiRuntimeManager(async () => runtime);

    await expect(manager.refresh()).resolves.toMatchObject({
      loggedIn: true,
      models: [
        { id: "custom/shared", upstreamProvider: "custom", modelId: "shared" },
        { id: "openai/shared", upstreamProvider: "openai", modelId: "shared" },
      ],
    });
    expect(manager.resolveAvailableModel("openai/shared")?.runtime).toBe(runtime);
  });

  it("passes an abort signal into runtime creation so a stalled create can time out", async () => {
    let creationSignal: AbortSignal | undefined;
    const manager = new PiRuntimeManager(async (options) => {
      creationSignal = options?.signal;
      return { getAvailable: async () => [] };
    });
    await manager.refresh();
    expect(creationSignal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed without exposing a provider exception", async () => {
    const manager = new PiRuntimeManager(async () => {
      throw new Error("Authorization: Bearer super-secret");
    });
    const status = await manager.refresh();
    expect(status).toMatchObject({
      loggedIn: false,
      models: [],
      unavailableReason: "discovery_failed",
    });
    expect(JSON.stringify(status)).not.toContain("super-secret");
  });
});
