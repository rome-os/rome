import { describe, expect, it } from "@rstest/core";
import type { Transcriber } from "./transcriber.js";
import { createVoiceInputSource } from "./voice-input-source.js";

const own: Transcriber = {
  place: { provider: "Soniox", host: "transcriber:8790" },
  model: "stt-rt-v6",
  open: () => ({ sendAudio: () => {}, finish: () => {}, abort: () => {} }),
};

const signedIn = () => ({ origin: "https://cloud.example", bearer: async () => "instance-1" });

/** Rome Cloud answering each request by its path; `calls` lists the paths asked. */
function answering(response: (path: string) => Response) {
  const calls: string[] = [];
  const fetch = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    return response(path);
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

const provider = () =>
  Response.json({ provider: "soniox", host: "stt-rt.soniox.com", model: "stt-rt-v6" });

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

  it("prefers Rome Cloud when signed in, and names its place before any session", async () => {
    const cloud = answering((path) =>
      path === "/v1/transcription/provider" ? provider() : granted(),
    );
    const source = createVoiceInputSource({ own, romeCloud: signedIn, fetch: cloud.fetch });
    expect(await source.info()).toEqual({
      available: true,
      via: "rome-cloud",
      place: { provider: "Soniox", host: "stt-rt.soniox.com" },
    });
    await source.info();
    // Naming the place mints no session, and is read once a minute at most.
    expect(cloud.calls()).toEqual(["/v1/transcription/provider"]);

    const opened = await source.open();
    expect(opened.ok && opened.source.romeCloudSessionId).toBe("session-1");
    expect(cloud.calls()).toEqual(["/v1/transcription/provider", "/v1/transcription/sessions"]);
  });

  it("says why it cannot name Rome Cloud's place, and guesses none", async () => {
    const unset = answering(() =>
      Response.json({ error: "voice_input_not_configured" }, { status: 503 }),
    );
    expect(
      await createVoiceInputSource({ own: null, romeCloud: signedIn, fetch: unset.fetch }).info(),
    ).toEqual({
      available: true,
      via: "rome-cloud",
      place: null,
      placeUnknown: "rome-cloud-not-configured",
    });

    const down = answering(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(
      await createVoiceInputSource({ own, romeCloud: signedIn, fetch: down.fetch }).info(),
    ).toEqual({
      available: true,
      via: "rome-cloud",
      place: null,
      placeUnknown: "rome-cloud-unreachable",
    });
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

  it("has no voice input for an account Rome Cloud does not allow", async () => {
    const gated = answering(() =>
      Response.json({ error: "voice_input_not_allowed" }, { status: 403 }),
    );
    const source = createVoiceInputSource({ own: null, romeCloud: signedIn, fetch: gated.fetch });
    expect(await source.info()).toEqual({ available: false, via: null, place: null });
    expect(gated.calls()).toEqual(["/v1/transcription/provider"]);
  });

  it("keeps the instance's own provider for an account Rome Cloud does not allow", async () => {
    const gated = answering(() =>
      Response.json({ error: "voice_input_not_allowed" }, { status: 403 }),
    );
    const source = createVoiceInputSource({ own, romeCloud: signedIn, fetch: gated.fetch });
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

  it("tells a revoked instance to sign in again rather than to wait for Rome Cloud", async () => {
    const revoked = answering(() => Response.json({ error: "instance_revoked" }, { status: 403 }));
    const source = createVoiceInputSource({ own: null, romeCloud: signedIn, fetch: revoked.fetch });
    expect(await source.info()).toEqual({
      available: true,
      via: "rome-cloud",
      place: null,
      placeUnknown: "rome-cloud-signed-out",
    });
    expect(await source.open()).toEqual({ ok: false, reason: "service-signed-out" });
  });

  it("refuses a session whose streaming address is not a socket address", async () => {
    const malformed = answering(() =>
      Response.json({
        sessionId: "session-1",
        provider: "soniox",
        url: "not-a-url",
        model: "stt-rt-v6",
        token: "temporary-1",
        expiresAt: "2026-11-14T03:35:00Z",
      }),
    );
    const source = createVoiceInputSource({
      own: null,
      romeCloud: signedIn,
      fetch: malformed.fetch,
    });
    expect(await source.open()).toEqual({ ok: false, reason: "service-unavailable" });
  });

  it("stops naming Rome Cloud's place once a session falls back to the instance's own provider", async () => {
    let revoked = false;
    const cloud = answering((path) => {
      if (revoked) return Response.json({ error: "instance_revoked" }, { status: 403 });
      return path === "/v1/transcription/provider" ? provider() : granted();
    });
    const source = createVoiceInputSource({ own, romeCloud: signedIn, fetch: cloud.fetch });
    expect((await source.info()).via).toBe("rome-cloud");
    revoked = true;
    await source.open();
    expect(await source.info()).toEqual({
      available: true,
      via: "instance",
      place: { provider: "Soniox", host: "transcriber:8790" },
    });
  });

  it("tells Rome Cloud which providers this build can use", async () => {
    const asked: Array<{ url: string; body?: string }> = [];
    const fetch = (async (url: URL | string, init?: RequestInit) => {
      asked.push({ url: String(url), body: init?.body as string | undefined });
      return String(url).includes("/provider") ? provider() : granted();
    }) as typeof globalThis.fetch;
    const source = createVoiceInputSource({ own: null, romeCloud: signedIn, fetch });
    await source.info();
    await source.open();
    expect(asked).toEqual([
      { url: "https://cloud.example/v1/transcription/provider?providers=soniox", body: undefined },
      {
        url: "https://cloud.example/v1/transcription/sessions",
        body: JSON.stringify({ providers: ["soniox"] }),
      },
    ]);
  });

  it("keeps the instance's own provider where Rome Cloud has none set up", async () => {
    const bare = answering(() =>
      Response.json({ error: "voice_input_not_configured" }, { status: 503 }),
    );
    const source = createVoiceInputSource({ own, romeCloud: signedIn, fetch: bare.fetch });
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

  it("asks Rome Cloud again for another account rather than reusing the last answer", async () => {
    let bearer = "instance-1";
    const cloud = answering(() =>
      bearer === "instance-1"
        ? provider()
        : Response.json({ error: "voice_input_not_allowed" }, { status: 403 }),
    );
    const caller = () => ({ origin: "https://cloud.example", bearer: async () => bearer });
    let signed = true;
    const source = createVoiceInputSource({
      own: null,
      romeCloud: () => (signed ? caller() : null),
      fetch: cloud.fetch,
    });
    expect((await source.info()).available).toBe(true);
    signed = false;
    await source.info();
    signed = true;
    bearer = "instance-2";

    expect(await source.info()).toEqual({ available: false, via: null, place: null });
    expect(cloud.calls()).toEqual(["/v1/transcription/provider", "/v1/transcription/provider"]);
  });
});
