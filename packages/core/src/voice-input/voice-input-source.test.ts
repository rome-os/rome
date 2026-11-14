import { describe, expect, it } from "@rstest/core";
import type { Transcriber } from "./transcriber.js";
import { createVoiceInputSource } from "./voice-input-source.js";

const own: Transcriber = {
  place: { provider: "Soniox", host: "transcriber:8790" },
  model: "stt-rt-v6",
  open: () => ({ sendAudio: () => {}, finish: () => {}, abort: () => {} }),
};

const signedIn = () => ({ origin: "https://cloud.example", bearer: async () => "instance-1" });

function answering(response: () => Response) {
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    return response();
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

const granted = () =>
  Response.json({
    sessionId: "session-1",
    provider: "soniox",
    url: "wss://stt-rt.soniox.com/transcribe-websocket",
    model: "stt-rt-v6",
    token: "temporary-1",
    expiresAt: "2026-11-14T03:35:00Z",
  });

describe("voice input source", () => {
  it("is absent with neither Rome Cloud nor the instance's own provider", async () => {
    const source = createVoiceInputSource({ own: null, romeCloud: () => null });
    expect(source.available()).toBe(false);
    expect(await source.info()).toEqual({ available: false, via: null, place: null });
  });

  it("uses the instance's own provider while not signed in", async () => {
    const source = createVoiceInputSource({ own, romeCloud: () => null });
    expect(await source.info()).toEqual({
      available: true,
      via: "instance",
      place: { provider: "Soniox", host: "transcriber:8790" },
    });
    expect(await source.open()).toEqual({
      ok: true,
      source: { transcriber: own, romeCloudSessionId: null },
    });
  });

  it("prefers Rome Cloud when signed in, and names the place it granted", async () => {
    const cloud = answering(granted);
    const source = createVoiceInputSource({ own, romeCloud: signedIn, fetch: cloud.fetch });
    expect(await source.info()).toEqual({
      available: true,
      via: "rome-cloud",
      place: { provider: "Soniox", host: "stt-rt.soniox.com" },
    });
    const opened = await source.open();
    expect(opened.ok && opened.source.romeCloudSessionId).toBe("session-1");
    // Settings asked once; each listening session asks again.
    expect(cloud.calls()).toBe(2);
    await source.info();
    expect(cloud.calls()).toBe(2);
  });

  it("falls back to the instance's own provider when Rome Cloud no longer takes the instance", async () => {
    const cloud = answering(() => Response.json({ error: "instance_revoked" }, { status: 403 }));
    const source = createVoiceInputSource({ own, romeCloud: signedIn, fetch: cloud.fetch });
    expect(await source.open()).toEqual({
      ok: true,
      source: { transcriber: own, romeCloudSessionId: null },
    });
  });

  it("reports Rome Cloud being out of reach apart from a refusal", async () => {
    const down = answering(() => {
      throw new Error("ECONNREFUSED");
    });
    const source = createVoiceInputSource({ own: null, romeCloud: signedIn, fetch: down.fetch });
    expect(await source.open()).toEqual({ ok: false, reason: "service-unavailable" });
    expect(source.available()).toBe(true);
  });
});
