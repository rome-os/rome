import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "@rstest/core";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceInputServerMessage } from "@rome/api-types/voice-input";
import { createSonioxTranscriber } from "./soniox.js";
import type { TranscriptionUsageSink } from "../usage/recorder.js";
import { type ServeOptions, serve } from "./voice-input-server.js";
import { createVoiceInputSource, type VoiceInputSource } from "./voice-input-source.js";

// A stand-in for Soniox's real-time endpoint. Each test scripts what it says.
interface FakeSoniox {
  url: string;
  /** Everything the adapter sent, in order: the start request, audio, the end frame. */
  received: Array<{ kind: "text"; text: string } | { kind: "audio"; bytes: number[] }>;
  authorization: () => string | undefined;
  closed: () => boolean;
  /** Sends a response to the open connection. */
  say(response: object): void;
  /** Called with each text frame; returns responses to send back. */
  onText: (text: string) => object[];
}

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function fakeSoniox(): Promise<FakeSoniox> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  let socket: WebSocket | null = null;
  let authorization: string | undefined;
  let closed = false;
  const fake: FakeSoniox = {
    url: "",
    received: [],
    authorization: () => authorization,
    closed: () => closed,
    say: (response) => socket?.send(JSON.stringify(response)),
    onText: () => [],
  };
  wss.on("connection", (ws, req) => {
    socket = ws;
    authorization = req.headers.authorization;
    ws.on("close", () => {
      closed = true;
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        fake.received.push({ kind: "audio", bytes: [...(data as Buffer)] });
        return;
      }
      const text = data.toString();
      fake.received.push({ kind: "text", text });
      for (const response of fake.onText(text)) ws.send(JSON.stringify(response));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  fake.url = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;
  servers.push({
    close: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.close();
    },
  });
  return fake;
}

/** The instance's own Soniox key, as `ROME_TRANSCRIPTION_*` configures it. */
function ownSource(fake: FakeSoniox): Pick<VoiceInputSource, "open"> {
  const transcriber = createSonioxTranscriber({ apiKey: "key-1", url: fake.url });
  return { open: async () => ({ ok: true, source: { transcriber, romeCloudSessionId: null } }) };
}

/** Rome's dictation socket in front of the fake, and a client connected to it. */
async function dictation(
  fake: FakeSoniox,
  maxDictationMs?: number,
  finishTimeoutMs?: number,
  options: Partial<ServeOptions> = {},
) {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) =>
    serve(ws, { source: ownSource(fake), maxDictationMs, finishTimeoutMs, ...options }),
  );
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.close();
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
  const messages: VoiceInputServerMessage[] = [];
  const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
  client.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve) => client.on("open", () => resolve()));
  return { client, messages, closed };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("voice input socket", () => {
  it("relays audio to the provider and streams the text back until the provider finishes", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) =>
      text === ""
        ? [
            {
              tokens: [
                { text: " world", is_final: true },
                { text: "<fin>", is_final: true },
              ],
            },
            { tokens: [], finished: true },
          ]
        : [];
    const { client, messages, closed } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(Buffer.from([1, 2, 3, 4]));
    client.send(Buffer.from([5, 6]));
    await until(() => fake.received.filter((frame) => frame.kind === "audio").length === 2);
    fake.say({
      tokens: [
        { text: "Hello", is_final: true },
        { text: " wor", is_final: false },
      ],
    });
    await until(() => messages.length === 1);
    client.send(JSON.stringify({ type: "stop" }));
    await closed;

    expect(fake.authorization()).toBe("Bearer key-1");
    const start = JSON.parse((fake.received[0] as { text: string }).text);
    expect(start).toMatchObject({ audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1 });
    expect(fake.received.slice(1)).toEqual([
      { kind: "audio", bytes: [1, 2, 3, 4] },
      { kind: "audio", bytes: [5, 6] },
      { kind: "text", text: "" },
    ]);
    expect(messages).toEqual([
      { type: "text", settled: "Hello", pending: " wor" },
      { type: "text", settled: " world", pending: "" },
      { type: "ended" },
    ]);
  });

  it("names a refused credential as the reason listening stopped", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) =>
      text.startsWith("{") ? [{ error_code: 401, error_message: "Invalid API key" }] : [];
    const { client, messages, closed } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "provider-refused" }]);
  });

  it("says the provider is unavailable when it drops the stream", async () => {
    const fake = await fakeSoniox();
    fake.onText = () => [];
    const { client, messages, closed } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await until(() => fake.received.length === 1);
    servers[0].close();
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "provider-unavailable" }]);
  });

  it("finishes a dictation that reaches the length limit and says why", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) =>
      text === ""
        ? [{ tokens: [{ text: "so far", is_final: true }] }, { tokens: [], finished: true }]
        : [];
    const { client, messages, closed } = await dictation(fake, 50);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await closed;

    expect(messages).toEqual([
      { type: "text", settled: "so far", pending: "" },
      { type: "error", reason: "time-limit" },
    ]);
  });

  it("closes a dictation whose provider never finishes after the length limit", async () => {
    const fake = await fakeSoniox();
    fake.onText = () => [];
    const { client, messages, closed } = await dictation(fake, 50, 50);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "time-limit" }]);
    await until(() => fake.closed());
  });

  it("closes a stopped dictation whose provider never finishes", async () => {
    const fake = await fakeSoniox();
    fake.onText = () => [];
    const { client, messages, closed } = await dictation(fake, undefined, 50);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(JSON.stringify({ type: "stop" }));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "provider-unavailable" }]);
  });

  it("refuses audio before start", async () => {
    const fake = await fakeSoniox();
    const { client, messages, closed } = await dictation(fake);

    client.send(Buffer.from([1, 2]));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "bad-request" }]);
    expect(fake.received).toEqual([]);
  });

  it("closes the provider stream when the client goes away", async () => {
    const fake = await fakeSoniox();
    const { client } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await until(() => fake.received.length === 1);
    client.close();

    await until(() => fake.closed());
  });

  it("stops at the time limit, keeping the text, when a temporary key's stream expires", async () => {
    const fake = await fakeSoniox();
    const { client, messages, closed } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(Buffer.from([1, 2]));
    await until(() => fake.received.some((frame) => frame.kind === "audio"));
    fake.say({ tokens: [{ text: "Hello", is_final: true }] });
    fake.say({
      error_code: 408,
      error_type: "temp_api_key_session_expired",
      error_message: "temp_api_key_session_expired: the session reached its time limit",
    });
    await closed;

    expect(messages).toEqual([
      { type: "text", settled: "Hello", pending: "" },
      { type: "error", reason: "time-limit" },
    ]);
  });

  it("clears the words still pending when the provider sends no tokens", async () => {
    const fake = await fakeSoniox();
    const { client, messages } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await until(() => fake.received.length === 1);
    fake.say({ tokens: [{ text: "wor", is_final: false }] });
    fake.say({ tokens: [] });
    await until(() => messages.length === 2);

    expect(messages).toEqual([
      { type: "text", settled: "", pending: "wor" },
      { type: "text", settled: "", pending: "" },
    ]);
  });

  it("closes a client that sends audio faster than a microphone records it", async () => {
    const fake = await fakeSoniox();
    const { client, messages, closed } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    // Over five seconds of 16 kHz audio at once.
    client.send(Buffer.alloc(100_000, 1));
    client.send(Buffer.alloc(100_000, 1));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "bad-request" }]);
  });

  it("sends the provider no audio that arrives after the stop", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) => (text === "" ? [{ tokens: [], finished: true }] : []);
    const { client, messages, closed } = await dictation(fake);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(Buffer.from([1, 2]));
    client.send(JSON.stringify({ type: "stop" }));
    client.send(Buffer.from([3, 4]));
    await closed;

    expect(fake.received.slice(1)).toEqual([
      { kind: "audio", bytes: [1, 2] },
      { kind: "text", text: "" },
    ]);
    expect(messages).toEqual([{ type: "ended" }]);
  });

  it("ends a dictation stopped just before the length limit as a plain stop", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) => {
      if (text === "") setTimeout(() => fake.say({ tokens: [], finished: true }), 150);
      return [];
    };
    const { client, messages, closed } = await dictation(fake, 80);

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await until(() => fake.received.length === 1);
    client.send(JSON.stringify({ type: "stop" }));
    await closed;

    expect(messages).toEqual([{ type: "ended" }]);
  });

  it("closes a stopped dictation whose source never answers", async () => {
    const fake = await fakeSoniox();
    const { client, messages, closed } = await dictation(fake, undefined, undefined, {
      source: { open: () => new Promise(() => {}) },
      openTimeoutMs: 50,
    });

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(JSON.stringify({ type: "stop" }));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "service-unavailable" }]);
  });

  it("says the provider is unavailable when it never accepts the connection", async () => {
    // Takes the TCP connection and never answers the upgrade.
    const silent = createTcpServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    servers.push({ close: () => silent.close() });
    const url = `ws://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const transcriber = createSonioxTranscriber({ apiKey: "key-1", url, connectTimeoutMs: 50 });
    const fake = await fakeSoniox();
    const { client, messages, closed } = await dictation(fake, undefined, undefined, {
      source: {
        open: async () => ({ ok: true, source: { transcriber, romeCloudSessionId: null } }),
      },
    });

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await closed;

    expect(messages).toEqual([{ type: "error", reason: "provider-unavailable" }]);
  });
});

describe("voice input on Rome Cloud", () => {
  /** Rome Cloud's session route, answering `answer`, after `delayMs`. */
  function romeCloud(answer: () => Response, delayMs = 0) {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetch = (async (url: URL | string, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      await new Promise((r) => setTimeout(r, delayMs));
      return answer();
    }) as typeof globalThis.fetch;
    return { requests, fetch };
  }

  function usageSink() {
    const recorded: Parameters<TranscriptionUsageSink["recordTranscription"]>[0][] = [];
    return { recorded, recordTranscription: (event: (typeof recorded)[0]) => recorded.push(event) };
  }

  it("takes each session's provider from Rome Cloud and reports the seconds it used", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) => (text === "" ? [{ tokens: [], finished: true }] : []);
    const cloud = romeCloud(
      () =>
        Response.json({
          sessionId: "session-1",
          provider: "soniox",
          url: fake.url,
          model: "stt-rt-v6",
          token: "temporary-1",
          expiresAt: "2026-11-14T03:35:00Z",
        }),
      30,
    );
    const source = createVoiceInputSource({
      own: null,
      romeCloud: () => ({ origin: "https://cloud.example", bearer: async () => "instance-1" }),
      fetch: cloud.fetch,
    });
    const usage = usageSink();
    const { client, messages, closed } = await dictation(fake, undefined, undefined, {
      source,
      usage,
    });

    // Audio and the stop both come before Rome Cloud answers.
    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(Buffer.alloc(32_000, 1));
    client.send(Buffer.alloc(16_000, 2));
    client.send(JSON.stringify({ type: "stop" }));
    await closed;

    expect(cloud.requests).toEqual([
      {
        url: "https://cloud.example/v1/transcription/sessions",
        authorization: "Bearer instance-1",
      },
    ]);
    expect(fake.authorization()).toBe("Bearer temporary-1");
    expect(
      fake.received.map((frame) => (frame.kind === "audio" ? frame.bytes.length : "text")),
    ).toEqual(["text", 32_000, 16_000, "text"]);
    expect(messages).toEqual([{ type: "ended" }]);
    expect(usage.recorded).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        provider: "soniox",
        model: "stt-rt-v6",
        seconds: 1.5,
        status: "ended",
      }),
    ]);
  });

  it("stops with Rome Cloud's reason when it refuses a session", async () => {
    const fake = await fakeSoniox();
    const cloud = romeCloud(() =>
      Response.json(
        { error: "voice_input_rate_limited", message: "Too many voice input sessions" },
        { status: 429 },
      ),
    );
    const source = createVoiceInputSource({
      own: null,
      romeCloud: () => ({ origin: "https://cloud.example", bearer: async () => "instance-1" }),
      fetch: cloud.fetch,
    });
    const usage = usageSink();
    const { client, messages, closed } = await dictation(fake, undefined, undefined, {
      source,
      usage,
    });

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    await closed;

    expect(messages).toEqual([
      { type: "error", reason: "service-refused", detail: "voice_input_rate_limited" },
    ]);
    expect(fake.received).toEqual([]);
    expect(usage.recorded).toEqual([]);
  });

  it("reports no usage for a session on the instance's own provider", async () => {
    const fake = await fakeSoniox();
    fake.onText = (text) => (text === "" ? [{ tokens: [], finished: true }] : []);
    const usage = usageSink();
    const { client, closed } = await dictation(fake, undefined, undefined, { usage });

    client.send(JSON.stringify({ type: "start", sampleRate: 16000 }));
    client.send(Buffer.alloc(3_200, 1));
    client.send(JSON.stringify({ type: "stop" }));
    await closed;

    expect(usage.recorded).toEqual([]);
  });
});
