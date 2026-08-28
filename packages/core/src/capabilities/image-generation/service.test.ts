import { describe, expect, it, rs } from "@rstest/core";
import type { ImageGenerationProvider, ImageProviderGenerateResult } from "@rome-os/app-runtime";
import { createImageGenerationService } from "./service.js";

function makeProvider(
  id: string,
  overrides: Partial<ImageGenerationProvider> = {},
): ImageGenerationProvider & {
  availability: ReturnType<typeof rs.fn>;
  generate: ReturnType<typeof rs.fn>;
} {
  return {
    id,
    displayName: `Provider ${id}`,
    availability: rs.fn(async () => ({ available: true }) as const),
    generate: rs.fn(
      async (): Promise<ImageProviderGenerateResult> => ({
        status: "ok",
        image: { data: "aGk=", mimeType: "image/png" },
      }),
    ),
    ...overrides,
  } as ImageGenerationProvider & {
    availability: ReturnType<typeof rs.fn>;
    generate: ReturnType<typeof rs.fn>;
  };
}

describe("createImageGenerationService", () => {
  it("lists registered providers", () => {
    const service = createImageGenerationService({
      providers: [makeProvider("a"), makeProvider("b")],
    });

    expect(service.listProviders()).toEqual([
      { id: "a", displayName: "Provider a" },
      { id: "b", displayName: "Provider b" },
    ]);
  });

  it("generates with the first available provider and stamps its id", async () => {
    const first = makeProvider("first");
    const second = makeProvider("second");
    const service = createImageGenerationService({ providers: [first, second] });

    const ctx = { sharedContext: { sessionId: "s-1" } };
    const outcome = await service.generate({ prompt: "a fox" }, ctx);

    expect(outcome).toEqual({
      status: "ok",
      providerId: "first",
      image: { data: "aGk=", mimeType: "image/png" },
    });
    expect(first.generate).toHaveBeenCalledWith({ prompt: "a fox" }, ctx);
    expect(second.generate).not.toHaveBeenCalled();
  });

  it("skips a provider whose availability says no and uses the next one", async () => {
    const down = makeProvider("down", {
      availability: rs.fn(async () => ({
        available: false as const,
        reason: "not connected",
        remedy: "Connect it.",
      })),
    });
    const up = makeProvider("up");
    const service = createImageGenerationService({ providers: [down, up] });

    const outcome = await service.generate({ prompt: "a fox" });

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.providerId).toBe("up");
    expect(down.generate).not.toHaveBeenCalled();
  });

  it("falls through to the next provider on a fail-closed unavailable generate result", async () => {
    // Availability is advisory: a provider can look available and still fail
    // closed at generate time (e.g. auth revoked mid-flight).
    const flaky = makeProvider("flaky", {
      generate: rs.fn(async () => ({
        status: "unavailable" as const,
        reason: "auth revoked",
        remedy: "Reconnect it.",
      })),
    });
    const up = makeProvider("up");
    const service = createImageGenerationService({ providers: [flaky, up] });

    const outcome = await service.generate({ prompt: "a fox" });

    expect(outcome.status).toBe("ok");
    if (outcome.status === "ok") expect(outcome.providerId).toBe("up");
  });

  it("stops the sweep on a failed result instead of retrying elsewhere", async () => {
    const refusing = makeProvider("refusing", {
      generate: rs.fn(async () => ({ status: "failed" as const, message: "content policy" })),
    });
    const up = makeProvider("up");
    const service = createImageGenerationService({ providers: [refusing, up] });

    const outcome = await service.generate({ prompt: "a fox" });

    expect(outcome).toEqual({
      status: "failed",
      providerId: "refusing",
      message: "content policy",
    });
    expect(up.generate).not.toHaveBeenCalled();
  });

  it("collects every provider's reason and remedy when none is available", async () => {
    const a = makeProvider("a", {
      availability: rs.fn(async () => ({
        available: false as const,
        reason: "not connected",
        remedy: "Connect A.",
      })),
    });
    const b = makeProvider("b", {
      generate: rs.fn(async () => ({
        status: "unavailable" as const,
        reason: "quota exhausted",
        remedy: "Wait for B.",
      })),
    });
    const service = createImageGenerationService({ providers: [a, b] });

    const outcome = await service.generate({ prompt: "a fox" });

    expect(outcome).toEqual({
      status: "unavailable",
      providers: [
        { id: "a", displayName: "Provider a", reason: "not connected", remedy: "Connect A." },
        { id: "b", displayName: "Provider b", reason: "quota exhausted", remedy: "Wait for B." },
      ],
    });
  });

  it("returns an empty unavailable outcome with no providers registered", async () => {
    const service = createImageGenerationService({ providers: [] });

    await expect(service.generate({ prompt: "a fox" })).resolves.toEqual({
      status: "unavailable",
      providers: [],
    });
  });

  it("still tries generate when the advisory availability check throws", async () => {
    const provider = makeProvider("shaky", {
      availability: rs.fn(async () => {
        throw new Error("probe timeout");
      }),
    });
    const service = createImageGenerationService({ providers: [provider] });

    const outcome = await service.generate({ prompt: "a fox" });

    expect(outcome.status).toBe("ok");
    expect(provider.generate).toHaveBeenCalledTimes(1);
  });

  it("maps an unexpected generate throw to a failed outcome", async () => {
    const provider = makeProvider("crashy", {
      generate: rs.fn(async () => {
        throw new Error("boom");
      }),
    });
    const service = createImageGenerationService({ providers: [provider] });

    await expect(service.generate({ prompt: "a fox" })).resolves.toEqual({
      status: "failed",
      providerId: "crashy",
      message: "boom",
    });
  });
});
