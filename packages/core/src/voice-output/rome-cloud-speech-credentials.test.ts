import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { RomeCloudCaller } from "../voice-input/rome-cloud-session.js";
import {
  createRomeCloudSpeechCredentials,
  type RomeCloudSpeechCredentials,
  SPEECH_SESSIONS_SETTING_KEY,
} from "./rome-cloud-speech-credentials.js";
import { requestRomeCloudSpeechSession } from "./rome-cloud-speech-session.js";

const MINUTE = 60_000;
const START = Date.parse("2026-11-22T10:00:00Z");

const signedIn = (credentialId = "credential-1"): RomeCloudCaller => ({
  origin: "https://cloud.example",
  credentialId,
  bearer: async () => "instance-bearer",
});

const session = (n: number, expiresAt: number) => ({
  sessionId: `speech-${n}`,
  provider: "soniox",
  url: "wss://tts-rt.soniox.com/tts-websocket",
  model: "tts-rt-v2",
  voice: "Iris",
  token: `temporary-${n}`,
  expiresAt: new Date(expiresAt).toISOString(),
});

/** Rome Cloud minting a new session on each request, an hour long from `now()`. */
function romeCloud(now: () => number) {
  const requests: { path: string; init?: RequestInit }[] = [];
  let answer: (() => Response) | null = null;
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    requests.push({ path: new URL(String(url)).pathname, init });
    if (answer) return answer();
    return Response.json(session(requests.length, now() + 60 * MINUTE));
  }) as typeof globalThis.fetch;
  return {
    fetch,
    requests,
    answer: (response: (() => Response) | null) => {
      answer = response;
    },
  };
}

function memorySettings(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async <T>(key: string) => (data.has(key) ? (structuredClone(data.get(key)) as T) : null),
    set: async (key: string, value: unknown) => {
      data.set(key, structuredClone(value));
    },
  };
}

const sources: RomeCloudSpeechCredentials[] = [];
afterEach(() => {
  for (const source of sources.splice(0)) source.stop();
  rs.restoreAllMocks();
});

function setup(
  options: {
    settings?: ReturnType<typeof memorySettings>;
    caller?: () => RomeCloudCaller | null;
  } = {},
) {
  let at = START;
  const clock = { now: () => at, advance: (ms: number) => (at += ms) };
  const cloud = romeCloud(clock.now);
  const settings = options.settings ?? memorySettings();
  const reported: unknown[] = [];
  let caller = options.caller ?? (() => signedIn());
  let failing = false;
  const make = () => {
    const source = createRomeCloudSpeechCredentials({
      romeCloud: () => caller(),
      settings,
      usage: {
        recordSpeech: async (event) => {
          if (failing) throw new Error("database is locked");
          reported.push(event);
        },
      },
      fetch: cloud.fetch,
      now: clock.now,
    });
    sources.push(source);
    return source;
  };
  return {
    clock,
    cloud,
    settings,
    reported,
    make,
    signAs: (next: () => RomeCloudCaller | null) => {
      caller = next;
    },
    failReports: (fail: boolean) => {
      failing = fail;
    },
  };
}

/** Everything written to the console while the test runs, silenced. */
function captureConsole() {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    rs.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return { text: () => lines.join("\n") };
}

// Lets the usage counts queued behind earlier work be written.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("speech sessions from Rome Cloud", () => {
  it("asks as the instance and answers the session's provider, address, model, voice and key", async () => {
    const { cloud, make } = setup();
    expect(await make().get()).toEqual({
      kind: "granted",
      credentials: {
        provider: "soniox",
        url: "wss://tts-rt.soniox.com/tts-websocket",
        model: "tts-rt-v2",
        voice: "Iris",
        token: "temporary-1",
        sessionId: "speech-1",
      },
    });
    expect(cloud.requests.map((r) => r.path)).toEqual(["/v1/speech/sessions"]);
    expect(cloud.requests[0].init?.method).toBe("POST");
    expect(new Headers(cloud.requests[0].init?.headers).get("authorization")).toBe(
      "Bearer instance-bearer",
    );
  });

  it("reuses one unexpired session for every conversation, also at once", async () => {
    const { cloud, make, clock } = setup();
    const source = make();
    const [a, b] = await Promise.all([source.get(), source.get()]);
    clock.advance(30 * MINUTE);
    const c = await source.get();
    expect(cloud.requests).toHaveLength(1);
    for (const outcome of [a, b, c]) {
      expect(outcome.kind === "granted" && outcome.credentials.sessionId).toBe("speech-1");
    }
  });

  it("keeps the session across a restart", async () => {
    const { cloud, make, settings } = setup();
    await make().get();
    expect(settings.data.has(SPEECH_SESSIONS_SETTING_KEY)).toBe(true);
    const outcome = await make().get();
    expect(outcome.kind === "granted" && outcome.credentials.sessionId).toBe("speech-1");
    expect(cloud.requests).toHaveLength(1);
  });

  it("asks for a new session in the last minutes of the old one", async () => {
    const { cloud, make, clock } = setup();
    const source = make();
    await source.get();
    clock.advance(54 * MINUTE);
    const before = await source.get();
    expect(before.kind === "granted" && before.credentials.sessionId).toBe("speech-1");
    clock.advance(2 * MINUTE);
    const after = await source.get();
    expect(after.kind === "granted" && after.credentials.sessionId).toBe("speech-2");
    expect(cloud.requests).toHaveLength(2);
  });

  it("never hands one sign-in's session to another", async () => {
    const { cloud, make, signAs } = setup();
    const source = make();
    await source.get();
    signAs(() => signedIn("credential-2"));
    const outcome = await source.get();
    expect(outcome.kind === "granted" && outcome.credentials.sessionId).toBe("speech-2");
    expect(cloud.requests).toHaveLength(2);
  });

  it("asks nothing while not signed in to Rome Cloud", async () => {
    const { cloud, make } = setup({ caller: () => null });
    expect(await make().get()).toEqual({ kind: "signed-out" });
    expect(cloud.requests).toHaveLength(0);
  });

  it("reports each session once, after it expired, with what was spoken on it", async () => {
    const { make, clock, reported, settings } = setup();
    const source = make();
    await source.get();
    source.recordUsage("speech-1", { characters: 120, seconds: 8.04 });
    source.recordUsage("speech-1", { characters: 30, seconds: 2 });
    await settled();

    clock.advance(60 * MINUTE);
    await source.report();
    // A stream opened just before the key expired may still be speaking.
    expect(reported).toEqual([]);

    clock.advance(6 * MINUTE);
    await source.report();
    await source.report();
    expect(reported).toEqual([
      {
        sessionId: "speech-1",
        provider: "soniox",
        model: "tts-rt-v2",
        characters: 150,
        seconds: 10,
      },
    ]);
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual([]);
    // Usage that comes after the report is not counted twice.
    source.recordUsage("speech-1", { characters: 5, seconds: 1 });
    await settled();
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual([]);
  });

  it("counts usage across a restart and reports a session an earlier run left", async () => {
    const { make, clock, reported } = setup();
    const first = make();
    await first.get();
    first.recordUsage("speech-1", { characters: 40, seconds: 3 });
    await settled();
    first.stop();

    const second = make();
    second.recordUsage("speech-1", { characters: 2, seconds: 0.5 });
    await settled();
    clock.advance(70 * MINUTE);
    await second.report();
    expect(reported).toEqual([
      expect.objectContaining({ sessionId: "speech-1", characters: 42, seconds: 3.5 }),
    ]);
  });

  it("keeps a session whose report could not be queued, and tries again after a minute", async () => {
    const { make, clock, reported, settings, failReports } = setup();
    const source = make();
    await source.get();
    source.recordUsage("speech-1", { characters: 20, seconds: 2 });
    await settled();
    clock.advance(70 * MINUTE);

    failReports(true);
    await source.report();
    expect(reported).toEqual([]);
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual([
      expect.objectContaining({ sessionId: "speech-1", characters: 20 }),
    ]);

    // Kept across a restart too, and not tried again within the minute.
    failReports(false);
    await source.report();
    expect(reported).toEqual([]);
    clock.advance(MINUTE);
    await source.report();
    expect(reported).toEqual([
      expect.objectContaining({ sessionId: "speech-1", characters: 20, seconds: 2 }),
    ]);
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual([]);

    // A new run picks up what an earlier run could not report.
    failReports(true);
    await source.get();
    clock.advance(70 * MINUTE);
    await source.report();
    source.stop();
    failReports(false);
    await make().report();
    expect(reported).toHaveLength(2);
  });

  it("drops the usage of a session that another sign-in opened", async () => {
    const { make, clock, reported, signAs, settings } = setup();
    const source = make();
    await source.get();
    source.recordUsage("speech-1", { characters: 10, seconds: 1 });
    await settled();
    signAs(() => signedIn("credential-2"));
    clock.advance(70 * MINUTE);
    await source.report();
    expect(reported).toEqual([]);
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual([]);
  });

  it("reports an expired session before asking for a new one", async () => {
    const { make, clock, reported, cloud } = setup();
    const source = make();
    await source.get();
    clock.advance(70 * MINUTE);
    const outcome = await source.get();
    expect(outcome.kind === "granted" && outcome.credentials.sessionId).toBe("speech-2");
    expect(reported).toEqual([expect.objectContaining({ sessionId: "speech-1" })]);
    expect(cloud.requests).toHaveLength(2);
  });

  it("asks for a new session once the provider refused the old one, and reports the old one after", async () => {
    const { cloud, make, clock, reported } = setup();
    const source = make();
    await source.get();
    source.recordUsage("speech-1", { characters: 12, seconds: 1 });
    clock.advance(10 * MINUTE);
    source.retire("speech-1");
    // Retiring an unknown or already retired session changes nothing.
    source.retire("speech-1");
    source.retire("speech-9");
    const outcome = await source.get();
    expect(outcome.kind === "granted" && outcome.credentials.sessionId).toBe("speech-2");
    expect(cloud.requests).toHaveLength(2);

    // A stream opened just before the refusal may still be speaking.
    clock.advance(5 * MINUTE);
    await source.report();
    expect(reported).toEqual([]);
    clock.advance(MINUTE);
    await source.report();
    expect(reported).toEqual([
      expect.objectContaining({ sessionId: "speech-1", characters: 12, seconds: 1 }),
    ]);
  });

  it("keeps a due session while signed out, and reports it once signed in again", async () => {
    const { make, clock, reported, signAs, settings } = setup();
    const source = make();
    await source.get();
    source.recordUsage("speech-1", { characters: 7, seconds: 1 });
    await settled();
    signAs(() => null);
    clock.advance(70 * MINUTE);
    await source.report();
    expect(reported).toEqual([]);
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual([
      expect.objectContaining({ sessionId: "speech-1", characters: 7 }),
    ]);

    signAs(() => signedIn());
    clock.advance(MINUTE);
    await source.report();
    expect(reported).toEqual([expect.objectContaining({ sessionId: "speech-1", characters: 7 })]);
  });

  it("passes Rome Cloud's refusals on, and keeps nothing", async () => {
    const { cloud, make, settings } = setup();
    const source = make();
    const refusal = (status: number, error: string) => () =>
      Response.json({ error, message: "no" }, { status });

    cloud.answer(refusal(403, "voice_input_not_allowed"));
    expect(await source.get()).toEqual({ kind: "refused", code: "voice_input_not_allowed" });
    cloud.answer(refusal(429, "speech_rate_limited"));
    expect(await source.get()).toEqual({ kind: "refused", code: "speech_rate_limited" });
    cloud.answer(refusal(503, "speech_not_configured"));
    expect(await source.get()).toEqual({ kind: "not-configured" });
    cloud.answer(refusal(503, "provider_unavailable"));
    expect(await source.get()).toEqual({ kind: "unavailable", detail: "provider_unavailable" });
    cloud.answer(refusal(503, "speech_unavailable"));
    expect(await source.get()).toEqual({ kind: "unavailable", detail: "speech_unavailable" });
    cloud.answer(refusal(401, "unauthorized"));
    expect(await source.get()).toEqual({ kind: "signed-out" });
    cloud.answer(refusal(403, "instance_revoked"));
    expect(await source.get()).toEqual({ kind: "signed-out" });
    cloud.answer(() => new Response("bad gateway", { status: 502 }));
    expect(await source.get()).toEqual({ kind: "unavailable", detail: "status 502" });
    expect(settings.data.has(SPEECH_SESSIONS_SETTING_KEY)).toBe(false);
  });

  it("answers unavailable for a session it cannot read", async () => {
    const { cloud, make } = setup();
    const source = make();
    const { expiresAt: _, ...noExpiry } = session(1, START + 60 * MINUTE);
    cloud.answer(() => Response.json(noExpiry));
    expect(await source.get()).toEqual({ kind: "unavailable", detail: "malformed session" });
    cloud.answer(() => Response.json({ ...session(1, START), url: "https://tts.example" }));
    expect(await source.get()).toEqual({ kind: "unavailable", detail: "malformed session" });
  });

  it("still speaks when the session cannot be kept, and never logs the error that quotes its key", async () => {
    const output = captureConsole();
    const settings = memorySettings();
    // As a database error does: it quotes the value it could not write.
    settings.set = async (_key, value) => {
      throw new Error(`Failed query: insert into settings\nparams: ${JSON.stringify(value)}`);
    };
    const { make, cloud } = setup({ settings });
    const source = make();
    expect((await source.get()).kind).toBe("granted");
    expect((await source.get()).kind).toBe("granted");
    expect(cloud.requests).toHaveLength(1);
    expect(output.text()).toContain("speech sessions not saved");
    expect(output.text()).not.toContain("temporary-1");
  });

  it("asks nothing and overwrites nothing while the stored sessions cannot be read", async () => {
    const output = captureConsole();
    const settings = memorySettings();
    const { make, cloud, clock } = setup({ settings });
    await make().get();
    const stored = structuredClone(settings.data.get(SPEECH_SESSIONS_SETTING_KEY));

    // A restart whose first read fails, with an error that quotes the row.
    const realGet = settings.get;
    let failReads = true;
    settings.get = async <T>(key: string) => {
      if (failReads) throw new Error(`Failed query: select\nresult: ${JSON.stringify(stored)}`);
      return realGet<T>(key);
    };
    const restarted = make();
    expect(await restarted.get()).toEqual({
      kind: "unavailable",
      detail: "speech sessions unreadable",
    });
    clock.advance(70 * MINUTE);
    await restarted.report();
    expect(cloud.requests).toHaveLength(1);
    expect(settings.data.get(SPEECH_SESSIONS_SETTING_KEY)).toEqual(stored);
    expect(output.text()).toContain("speech sessions unreadable");
    expect(output.text()).not.toContain("temporary-1");

    // The next call reads again, and finds the session to report.
    failReads = false;
    clock.advance(-70 * MINUTE);
    const outcome = await restarted.get();
    expect(outcome.kind === "granted" && outcome.credentials.sessionId).toBe("speech-1");
    expect(cloud.requests).toHaveLength(1);
  });

  it("ignores a stored value it does not recognise", async () => {
    const settings = memorySettings({ [SPEECH_SESSIONS_SETTING_KEY]: [{ sessionId: 3 }, "x"] });
    const { make, cloud } = setup({ settings });
    expect((await make().get()).kind).toBe("granted");
    expect(cloud.requests).toHaveLength(1);
  });
});

describe("speech session request", () => {
  it("does not ask without a bearer", async () => {
    let asked = false;
    const outcome = await requestRomeCloudSpeechSession(
      { ...signedIn(), bearer: async () => null },
      (async () => {
        asked = true;
        return Response.json({});
      }) as typeof fetch,
    );
    expect(outcome).toEqual({ kind: "unavailable", detail: "no bearer" });
    expect(asked).toBe(false);
  });

  it("answers unavailable when Rome Cloud cannot be reached", async () => {
    const outcome = await requestRomeCloudSpeechSession(signedIn(), (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    expect(outcome).toEqual({ kind: "unavailable", detail: "ECONNREFUSED" });
  });
});
