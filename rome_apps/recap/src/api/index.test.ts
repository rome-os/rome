import { describe, expect, it, rs } from "@rstest/core";
import type { RomeAppContext } from "@rome-os/app-runtime";
import { createApiHandler } from "./index.js";
import {
  RECAP_AUDIO_SPEED_SETTING,
  RECAP_CREATE_AUDIO_SETTING,
  RECAP_ENABLED_SETTING,
  RECAP_THRESHOLD_SETTING,
  type RecapAudioSpeed,
  type RecapThreshold,
} from "../settings.js";

function createContext(
  values: {
    enabled?: boolean | null;
    createAudio?: boolean | null;
    threshold?: RecapThreshold | null;
    audioSpeed?: RecapAudioSpeed | null;
  } = {},
): RomeAppContext {
  const settings = {
    get: rs.fn(async (key: string) => {
      if (key === RECAP_ENABLED_SETTING) return values.enabled ?? null;
      if (key === RECAP_CREATE_AUDIO_SETTING) return values.createAudio ?? null;
      if (key === RECAP_THRESHOLD_SETTING) return values.threshold ?? null;
      if (key === RECAP_AUDIO_SPEED_SETTING) return values.audioSpeed ?? null;
      return null;
    }),
    set: rs.fn(async () => undefined),
  };
  return {
    app: { id: "recap", version: "0.1.0", description: "Recap" },
    controller: {},
    db: {} as never,
    log: { debug: rs.fn(), info: rs.fn(), warn: rs.fn(), error: rs.fn() },
    repositories: { settings },
    runAction: rs.fn(async () => ({ status: "ok" as const })),
    listRoutines: rs.fn(async () => []),
  };
}

describe("recap API", () => {
  it("reads recap settings", async () => {
    const handler = createApiHandler(
      createContext({ enabled: true, createAudio: true, threshold: "long", audioSpeed: "faster" }),
    );

    const response = await handler.handle({
      method: "GET",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      createAudio: true,
      threshold: "long",
      audioSpeed: "faster",
    });
  });

  it("falls back to recaps off and the default faster audio speed", async () => {
    const handler = createApiHandler(createContext());

    const response = await handler.handle({
      method: "GET",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabled: false,
      createAudio: false,
      threshold: "medium",
      audioSpeed: "faster",
    });
  });

  it("updates recap settings", async () => {
    const ctx = createContext({ createAudio: false, threshold: "medium" });
    const handler = createApiHandler(ctx);

    const response = await handler.handle({
      method: "PUT",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
      body: new TextEncoder().encode(
        JSON.stringify({
          enabled: true,
          createAudio: true,
          threshold: "short",
          audioSpeed: "fastest",
        }),
      ),
    });

    expect(response.status).toBe(200);
    expect(ctx.repositories.settings.set).toHaveBeenCalledWith("recap.enabled", true);
    expect(ctx.repositories.settings.set).toHaveBeenCalledWith("recap.createAudio", true);
    expect(ctx.repositories.settings.set).toHaveBeenCalledWith("recap.threshold", "short");
    expect(ctx.repositories.settings.set).toHaveBeenCalledWith("recap.audioSpeed", "fastest");
    await expect(response.json()).resolves.toEqual({
      enabled: true,
      createAudio: true,
      threshold: "short",
      audioSpeed: "fastest",
    });
  });

  it("keeps the stored enabled value when an update omits it", async () => {
    const ctx = createContext({ enabled: true });
    const handler = createApiHandler(ctx);

    const response = await handler.handle({
      method: "PUT",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
      body: new TextEncoder().encode(
        JSON.stringify({ createAudio: false, threshold: "medium", audioSpeed: "normal" }),
      ),
    });

    expect(response.status).toBe(200);
    expect(ctx.repositories.settings.set).toHaveBeenCalledWith("recap.enabled", true);
  });

  it("rejects a non-boolean enabled value", async () => {
    const handler = createApiHandler(createContext());

    const response = await handler.handle({
      method: "PUT",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
      body: new TextEncoder().encode(
        JSON.stringify({
          enabled: "yes",
          createAudio: false,
          threshold: "medium",
          audioSpeed: "normal",
        }),
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "enabled_boolean_required" });
  });

  it("rejects invalid thresholds", async () => {
    const handler = createApiHandler(createContext());

    const response = await handler.handle({
      method: "PUT",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
      body: new TextEncoder().encode(
        JSON.stringify({ createAudio: true, threshold: "tiny", audioSpeed: "normal" }),
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "threshold_invalid" });
  });

  it("rejects invalid audio speeds", async () => {
    const handler = createApiHandler(createContext());

    const response = await handler.handle({
      method: "PUT",
      path: ["settings"],
      headers: {},
      query: new URLSearchParams(),
      caller: { kind: "guardian", userId: "u1", via: "cookie" },
      body: new TextEncoder().encode(
        JSON.stringify({ createAudio: true, threshold: "medium", audioSpeed: "warp" }),
      ),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "audio_speed_invalid" });
  });
});
