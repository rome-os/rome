import { describe, expect, it } from "@rstest/core";
import { createVoiceInputSource } from "./voice-input-source.js";

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
  it("is absent while not signed in to Rome Cloud", async () => {
    const source = createVoiceInputSource({ romeCloud: () => null });
    expect(source.available()).toBe(false);
    expect(await source.info()).toEqual({ available: false, place: null });
    expect(await source.open()).toEqual({ ok: false, reason: "service-unavailable" });
  });

  it("names Rome Cloud's place before any session, and opens one per listening session", async () => {
    const cloud = answering((path) =>
      path === "/v1/transcription/provider" ? provider() : granted(),
    );
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: cloud.fetch });
    expect(await source.info()).toEqual({
      available: true,
      place: { provider: "Soniox", host: "stt-rt.soniox.com" },
    });
    await source.info();
    // Naming the place mints no session, and is read once a minute at most.
    expect(cloud.calls()).toEqual(["/v1/transcription/provider"]);

    const opened = await source.open();
    expect(opened.ok && opened.source.romeCloudSessionId).toBe("session-1");
    expect(opened.ok && opened.source.transcriber.providerId).toBe("soniox");
    expect(cloud.calls()).toEqual(["/v1/transcription/provider", "/v1/transcription/sessions"]);
  });

  it("says why it cannot name Rome Cloud's place, and guesses none", async () => {
    const unset = answering(() =>
      Response.json({ error: "voice_input_not_configured" }, { status: 503 }),
    );
    expect(
      await createVoiceInputSource({ romeCloud: signedIn, fetch: unset.fetch }).info(),
    ).toEqual({ available: true, place: null, placeUnknown: "rome-cloud-not-configured" });

    const down = answering(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await createVoiceInputSource({ romeCloud: signedIn, fetch: down.fetch }).info()).toEqual(
      { available: true, place: null, placeUnknown: "rome-cloud-unreachable" },
    );
  });

  it("reports Rome Cloud being out of reach apart from a refusal", async () => {
    const down = answering(() => {
      throw new Error("ECONNREFUSED");
    });
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: down.fetch });
    expect(await source.open()).toEqual({ ok: false, reason: "service-unavailable" });
    expect(source.available()).toBe(true);
  });

  it("stops with Rome Cloud's reason when it refuses a session", async () => {
    const limited = answering(() =>
      Response.json({ error: "voice_input_rate_limited" }, { status: 429 }),
    );
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: limited.fetch });
    expect(await source.open()).toEqual({
      ok: false,
      reason: "service-refused",
      detail: "voice_input_rate_limited",
    });
  });

  it("has no voice input for an account Rome Cloud does not allow", async () => {
    const gated = answering(() =>
      Response.json({ error: "voice_input_not_allowed" }, { status: 403 }),
    );
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: gated.fetch });
    expect(await source.info()).toEqual({ available: false, place: null });
    expect(gated.calls()).toEqual(["/v1/transcription/provider"]);
  });

  it("tells a revoked instance to sign in again rather than to wait for Rome Cloud", async () => {
    const revoked = answering(() => Response.json({ error: "instance_revoked" }, { status: 403 }));
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: revoked.fetch });
    expect(await source.info()).toEqual({
      available: true,
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
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: malformed.fetch });
    expect(await source.open()).toEqual({ ok: false, reason: "service-unavailable" });
  });

  it("stops naming Rome Cloud's place once a session is refused", async () => {
    let revoked = false;
    const cloud = answering((path) => {
      if (revoked) return Response.json({ error: "instance_revoked" }, { status: 403 });
      return path === "/v1/transcription/provider" ? provider() : granted();
    });
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch: cloud.fetch });
    expect((await source.info()).place).not.toBeNull();
    revoked = true;
    await source.open();
    expect(await source.info()).toEqual({
      available: true,
      place: null,
      placeUnknown: "rome-cloud-signed-out",
    });
  });

  it("tells Rome Cloud which providers this build can use", async () => {
    const asked: Array<{ url: string; body?: string }> = [];
    const fetch = (async (url: URL | string, init?: RequestInit) => {
      asked.push({ url: String(url), body: init?.body as string | undefined });
      return String(url).includes("/provider") ? provider() : granted();
    }) as typeof globalThis.fetch;
    const source = createVoiceInputSource({ romeCloud: signedIn, fetch });
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
      romeCloud: () => (signed ? caller() : null),
      fetch: cloud.fetch,
    });
    expect((await source.info()).available).toBe(true);
    signed = false;
    await source.info();
    signed = true;
    bearer = "instance-2";

    expect(await source.info()).toEqual({ available: false, place: null });
    expect(cloud.calls()).toEqual(["/v1/transcription/provider", "/v1/transcription/provider"]);
  });
});
