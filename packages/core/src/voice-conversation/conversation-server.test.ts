import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "@rstest/core";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceConversationServerMessage } from "@rome/api-types/voice-conversation";
import type { DrizzleDb } from "../db/index.js";
import type { Transcriber, TranscriptionListener } from "../voice-input/transcriber.js";
import type { SpeakerListener } from "../voice-output/speaker.js";
import type { SpeakerSource } from "../voice-output/speaker-source.js";
import type { ReplyTurn } from "./conversation.js";
import {
  attachVoiceConversationServer,
  serve,
  type VoiceConversationDeps,
} from "./conversation-server.js";

const servers: Array<{ close(): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function until(check: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/** A transcriber the test speaks through. */
function standInTranscriber() {
  const audio: number[][] = [];
  const opened: object[] = [];
  let listener: TranscriptionListener | null = null;
  let aborted = false;
  const transcriber: Transcriber = {
    place: { provider: "Soniox", host: "stt.example" },
    model: "stt-rt-v6",
    providerId: "soniox",
    open(options, l) {
      opened.push(options);
      listener = l;
      return {
        sendAudio: (chunk) => audio.push([...chunk]),
        finish: () => {},
        abort: () => {
          aborted = true;
        },
        get sentBytes() {
          return audio.flat().length;
        },
      };
    },
  };
  return {
    transcriber,
    audio,
    opened,
    aborted: () => aborted,
    listener: () => {
      if (!listener) throw new Error("not listening");
      return listener;
    },
  };
}

/** A speaker that speaks each sentence as 100 ms of silence at once. */
function standInSpeaker(outcome: "ok" | "disabled" = "ok") {
  const said: string[] = [];
  let closed = false;
  const source: SpeakerSource = {
    async open(listener: SpeakerListener) {
      if (outcome === "disabled") return { ok: false, reason: "disabled" };
      return {
        ok: true,
        provider: "soniox",
        session: {
          format: { encoding: "pcm_s16le", sampleRate: 24_000 },
          say(id, text) {
            said.push(text);
            setTimeout(() => {
              listener.onAudio({ sentenceId: id, streamId: "s", pcm: new Uint8Array(4800) });
              listener.onSentenceEnd(id);
            }, 0);
          },
          stop: () => [],
          close: () => {
            closed = true;
          },
        },
      };
    },
  };
  return { source, said, closed: () => closed };
}

const replyOf = (text: string): ReplyTurn => ({
  events: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta" as const, content: text };
    },
  }),
});

async function connect(deps: VoiceConversationDeps) {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => serve(ws, deps));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      http.close();
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${(http.address() as AddressInfo).port}`);
  const messages: VoiceConversationServerMessage[] = [];
  const audio: number[] = [];
  const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
  client.on("message", (data, isBinary) => {
    if (isBinary) {
      audio.push((data as Buffer).byteLength);
      return;
    }
    const message = JSON.parse(data.toString()) as VoiceConversationServerMessage;
    if (message.type !== "alive") messages.push(message);
  });
  await new Promise<void>((resolve) => client.on("open", () => resolve()));
  return { client, messages, audio, closed };
}

describe("voice conversation socket", () => {
  it("listens for turns, sends each to the chat and streams the spoken reply down", async () => {
    const ear = standInTranscriber();
    const mouth = standInSpeaker();
    const sent: { chatId: string; text: string }[] = [];
    const usage: { status: string; seconds: number }[] = [];
    const { client, messages, audio, closed } = await connect({
      listening: {
        open: async () => ({
          ok: true,
          source: { transcriber: ear.transcriber, romeCloudSessionId: "session-1" },
        }),
      },
      speaker: mouth.source,
      send: async (chatId, text) => {
        sent.push({ chatId, text });
        return replyOf("好的，已经合并了。");
      },
      usage: { recordTranscription: (event) => usage.push(event) },
      voiceTerms: async () => ["Rome"],
    });

    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    client.send(Buffer.from([1, 2, 3, 4]));
    await until(() => messages.some((m) => m.type === "ready"), "ready");
    expect(messages.slice(0, 2)).toEqual([
      { type: "ready", sampleRate: 24_000 },
      { type: "state", state: "listening" },
    ]);
    expect(ear.opened).toEqual([{ sampleRate: 16_000, mode: "conversation", terms: ["Rome"] }]);
    await until(() => ear.audio.length === 1, "audio relayed");

    ear.listener().onText("合并了吗？", "");
    ear.listener().onEndpoint?.();
    await until(() => audio.length === 1, "reply audio");
    expect(sent).toEqual([{ chatId: "chat-1", text: "合并了吗？" }]);
    expect(mouth.said).toEqual(["好的，已经合并了。"]);
    expect(audio).toEqual([4800]);
    expect(messages).toContainEqual({ type: "turn", text: "合并了吗？" });
    expect(messages).toContainEqual({ type: "caption", text: "好的，已经合并了。" });

    client.send(JSON.stringify({ type: "stop" }));
    await closed;
    expect(messages.at(-1)).toEqual({ type: "ended" });
    expect(ear.aborted()).toBe(true);
    expect(mouth.closed()).toBe(true);
    expect(usage).toEqual([
      expect.objectContaining({ sessionId: "session-1", status: "ended", seconds: 0 }),
    ]);
  });

  it("ends at once, listening to nothing, while voice mode is off", async () => {
    let listened = 0;
    const { client, messages, closed } = await connect({
      listening: {
        open: async () => {
          listened++;
          return { ok: false, reason: "service-unavailable" };
        },
      },
      speaker: standInSpeaker("disabled").source,
      send: async () => replyOf(""),
    });
    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    await closed;
    expect(messages).toEqual([{ type: "error", reason: "unavailable" }]);
    expect(listened).toBe(0);
  });

  it("ends when Rome cannot listen, and lets go of the speaker", async () => {
    const mouth = standInSpeaker();
    const { client, messages, closed } = await connect({
      listening: { open: async () => ({ ok: false, reason: "service-refused" }) },
      speaker: mouth.source,
      send: async () => replyOf(""),
    });
    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    await closed;
    expect(messages).toEqual([{ type: "error", reason: "listening-failed" }]);
    expect(mouth.closed()).toBe(true);
  });

  it("refuses audio before start", async () => {
    const first = await connect({
      listening: { open: async () => ({ ok: false, reason: "service-refused" }) },
      speaker: standInSpeaker().source,
      send: async () => replyOf(""),
    });
    first.client.send(Buffer.from([1, 2]));
    await first.closed;
    expect(first.messages).toEqual([{ type: "error", reason: "bad-request" }]);
  });

  it("is not there while voice mode is off", async () => {
    const http: Server = createServer();
    const voice = attachVoiceConversationServer(
      http,
      {} as DrizzleDb,
      {
        listening: { open: async () => ({ ok: false, reason: "service-refused" }) },
        speaker: standInSpeaker().source,
        send: async () => replyOf(""),
      },
      async () => false,
    );
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    servers.push({ close: () => (voice.close(), http.close()) });
    const client = new WebSocket(
      `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws/voice-conversation`,
    );
    const status = await new Promise<number>((resolve) => {
      client.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      client.on("open", () => resolve(101));
    });
    expect(status).toBe(404);
  });
});
