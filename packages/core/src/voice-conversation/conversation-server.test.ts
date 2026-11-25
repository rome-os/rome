import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceConversationServerMessage } from "@rome/api-types/voice-conversation";
import { currentSessionActor, type SessionActor } from "../access/session-actor.js";
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

// Who the upgrade proves the caller to be. Null refuses it as unauthenticated.
const gate = rs.hoisted(() => ({
  caller: null as
    | null
    | { kind: "guardian" }
    | { kind: "visitor"; accountId: string; email: string },
}));
rs.mock("../access/ws-guardian-gate.js", () => ({
  gateUpgrade: async (_req: unknown, socket: import("node:stream").Duplex) => {
    if (gate.caller) return gate.caller;
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return null;
  },
}));

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
function standInSpeaker(outcome: "ok" | "not-configured" = "ok") {
  const said: string[] = [];
  let closed = false;
  const source: SpeakerSource = {
    async open(listener: SpeakerListener) {
      if (outcome === "not-configured") return { ok: false, reason: "not-configured" };
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

async function connect(deps: VoiceConversationDeps, actor?: SessionActor) {
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => serve(ws, deps, actor));
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
    const sent: { chatId: string; text: string; actor?: SessionActor }[] = [];
    const inputIds: string[] = [];
    const guardian: SessionActor = { kind: "guardian", userId: "seat", via: "cookie" };
    const usage: { status: string; seconds: number }[] = [];
    const { client, messages, audio, closed } = await connect(
      {
        listening: {
          open: async () => ({
            ok: true,
            source: { transcriber: ear.transcriber, romeCloudSessionId: "session-1" },
          }),
        },
        speaker: mouth.source,
        canTalkIn: async () => true,
        send: async (chatId, text, inputId) => {
          inputIds.push(inputId);
          sent.push({ chatId, text, actor: await currentSessionActor() });
          return replyOf("好的，已经合并了。");
        },
        usage: { recordTranscription: (event) => usage.push(event) },
        voiceTerms: async () => ["Rome"],
      },
      guardian,
    );

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
    // The turn is the guardian's, as a typed one is.
    expect(sent).toEqual([{ chatId: "chat-1", text: "合并了吗？", actor: guardian }]);
    expect(mouth.said).toEqual(["好的，已经合并了。"]);
    expect(audio).toEqual([4800]);
    // The turn names the message it was sent as.
    expect(messages).toContainEqual({ type: "turn", text: "合并了吗？", inputId: inputIds[0] });
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

  it("ends at once, listening to nothing, when speaking is not set up", async () => {
    let listened = 0;
    const { client, messages, closed } = await connect({
      listening: {
        open: async () => {
          listened++;
          return { ok: false, reason: "service-unavailable" };
        },
      },
      speaker: standInSpeaker("not-configured").source,
      canTalkIn: async () => true,
      send: async () => replyOf(""),
    });
    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    await closed;
    expect(messages).toEqual([{ type: "error", reason: "unavailable" }]);
    expect(listened).toBe(0);
  });

  it("refuses a chat that cannot take spoken turns before opening any session", async () => {
    let listened = 0;
    let spoke = 0;
    const checked: string[] = [];
    const { client, messages, closed } = await connect({
      listening: {
        open: async () => {
          listened++;
          return { ok: false, reason: "service-unavailable" };
        },
      },
      speaker: {
        open: async () => {
          spoke++;
          return { ok: false, reason: "not-configured" };
        },
      },
      canTalkIn: async (chatId) => {
        checked.push(chatId);
        return false;
      },
      send: async () => replyOf(""),
    });
    client.send(JSON.stringify({ type: "start", chatId: "concierge", sampleRate: 16_000 }));
    await closed;
    expect(messages).toEqual([{ type: "error", reason: "chat-refused" }]);
    expect(checked).toEqual(["concierge"]);
    expect([listened, spoke]).toEqual([0, 0]);
  });

  it("ends when Rome cannot listen, and lets go of the speaker", async () => {
    const mouth = standInSpeaker();
    const { client, messages, closed } = await connect({
      listening: { open: async () => ({ ok: false, reason: "service-refused" }) },
      speaker: mouth.source,
      canTalkIn: async () => true,
      send: async () => replyOf(""),
    });
    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    await closed;
    expect(messages).toEqual([{ type: "error", reason: "listening-failed" }]);
    expect(mouth.closed()).toBe(true);
  });

  it("holds the chat as followed only while the reply to a spoken turn is read, so that reply does not also push", async () => {
    const ear = standInTranscriber();
    const following: string[] = [];
    let released = 0;
    let finishReply = () => {};
    const replyDone = new Promise<void>((resolve) => {
      finishReply = resolve;
    });
    const guardian: SessionActor = { kind: "guardian", userId: "seat", via: "cookie" };
    const { client, messages, closed } = await connect(
      {
        listening: {
          open: async () => ({
            ok: true,
            source: { transcriber: ear.transcriber, romeCloudSessionId: "session-1" },
          }),
        },
        speaker: standInSpeaker().source,
        canTalkIn: async () => true,
        // A reply that runs until the test lets it end.
        send: async () => ({
          events: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: "text_delta" as const, content: "好的。" };
              await replyDone;
            },
          }),
        }),
        follow: (owner, chatId) => {
          following.push(`${owner} ${chatId}`);
          return () => {
            released++;
          };
        },
      },
      guardian,
    );
    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    await until(() => messages.some((m) => m.type === "ready"), "ready");
    // No turn yet: what the chat gets pushes as usual.
    expect(following).toEqual([]);

    ear.listener().onText("合并了吗？", "");
    ear.listener().onEndpoint?.();
    await until(() => following.length === 1, "followed");
    expect(following).toEqual(["guardian chat-1"]);
    expect(released).toBe(0);
    finishReply();
    // The reply was read: later messages, such as a task's result, push again.
    await until(() => released === 1, "released");

    client.send(JSON.stringify({ type: "stop" }));
    await closed;
    expect(released).toBe(1);
  });

  it("lets go of a turn's hold when the conversation ends mid-reply", async () => {
    const ear = standInTranscriber();
    let followed = 0;
    let released = 0;
    const { client, messages, closed } = await connect(
      {
        listening: {
          open: async () => ({
            ok: true,
            source: { transcriber: ear.transcriber, romeCloudSessionId: "session-1" },
          }),
        },
        speaker: standInSpeaker().source,
        canTalkIn: async () => true,
        // A reply that never ends.
        send: async () => ({
          events: () => ({
            async *[Symbol.asyncIterator]() {
              await new Promise(() => {});
            },
          }),
        }),
        follow: () => {
          followed++;
          return () => {
            released++;
          };
        },
      },
      { kind: "guardian", userId: "seat", via: "cookie" },
    );
    client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
    await until(() => messages.some((m) => m.type === "ready"), "ready");
    ear.listener().onText("在吗", "");
    ear.listener().onEndpoint?.();
    await until(() => followed === 1, "followed");
    client.send(JSON.stringify({ type: "stop" }));
    await closed;
    await until(() => released === 1, "released");
    expect(released).toBe(1);
  });

  it("refuses audio before start", async () => {
    const first = await connect({
      listening: { open: async () => ({ ok: false, reason: "service-refused" }) },
      speaker: standInSpeaker().source,
      canTalkIn: async () => true,
      send: async () => replyOf(""),
    });
    first.client.send(Buffer.from([1, 2]));
    await first.closed;
    expect(first.messages).toEqual([{ type: "error", reason: "bad-request" }]);
  });

  describe("a person taken off the team", () => {
    afterEach(() => {
      rs.useRealTimers();
    });

    // A conversation that is listening, for a person whose place on the team the test sets.
    async function listeningConversation() {
      const team = { on: true };
      const ear = standInTranscriber();
      const sent: string[] = [];
      const conversation = await connect({
        listening: {
          open: async () => ({
            ok: true,
            source: { transcriber: ear.transcriber, romeCloudSessionId: "session-1" },
          }),
        },
        speaker: standInSpeaker().source,
        canTalkIn: async () => true,
        send: async (_chatId, text) => {
          sent.push(text);
          return replyOf("好的。");
        },
        voiceTerms: async () => [],
        onTeam: () => team.on,
      });
      conversation.client.send(
        JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }),
      );
      await until(() => conversation.messages.some((m) => m.type === "ready"), "ready");
      return { ...conversation, team, ear, sent };
    }

    it("loses the conversation at the next membership check", async () => {
      rs.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { team, ear, messages, closed } = await listeningConversation();

      team.on = false;
      rs.advanceTimersByTime(25_000);

      await closed;
      expect(messages.at(-1)).toEqual({ type: "error", reason: "chat-refused" });
      expect(ear.aborted()).toBe(true);
    });

    it("sends no further turn to the chat", async () => {
      const { team, ear, sent, messages, closed } = await listeningConversation();

      team.on = false;
      ear.listener().onText("还在吗？", "");
      ear.listener().onEndpoint?.();

      await closed;
      expect(sent).toEqual([]);
      expect(messages.at(-1)).toEqual({ type: "error", reason: "chat-refused" });
    });

    it("opens no session once off the team", async () => {
      let listened = 0;
      let spoke = 0;
      const { client, messages, closed } = await connect({
        listening: {
          open: async () => {
            listened++;
            return { ok: false, reason: "service-unavailable" };
          },
        },
        speaker: {
          open: async () => {
            spoke++;
            return { ok: false, reason: "not-configured" };
          },
        },
        canTalkIn: async () => true,
        send: async () => replyOf(""),
        onTeam: () => false,
      });

      client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));

      await closed;
      expect(messages).toEqual([{ type: "error", reason: "chat-refused" }]);
      expect([listened, spoke]).toEqual([0, 0]);
    });
  });

  describe("who may open it", () => {
    afterEach(() => {
      gate.caller = null;
    });

    // The status the upgrade answers, and how often Rome Cloud's list was asked.
    const upgrade = async (signedIn: boolean, onList: boolean) => {
      let asked = 0;
      const http: Server = createServer();
      const voice = attachVoiceConversationServer(http, {} as DrizzleDb, {
        listening: {
          available: () => signedIn,
          info: async () => {
            asked++;
            return { available: onList, place: null };
          },
          open: async () => ({ ok: false, reason: "service-refused" }),
        },
        speaker: standInSpeaker().source,
        canTalkIn: async () => true,
        send: async () => replyOf(""),
        dashboardAccess: { isCloudEmailAllowed: () => true },
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      servers.push({ close: () => (voice.close(), http.close()) });
      const client = new WebSocket(
        `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws/voice-conversation`,
      );
      const status = await new Promise<number>((resolve) => {
        client.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        client.on("open", () => resolve(101));
        client.on("error", () => resolve(0));
      });
      return { status, asked };
    };

    it("is not there without a Rome Cloud sign-in, asking it nothing", async () => {
      gate.caller = { kind: "guardian" };
      expect(await upgrade(false, true)).toEqual({ status: 404, asked: 0 });
    });

    it("never asks Rome Cloud for a caller off the team", async () => {
      expect(await upgrade(true, true)).toEqual({ status: 401, asked: 0 });
    });

    it("lets a dashboard admin in on the guardian's voice input list", async () => {
      gate.caller = { kind: "visitor", accountId: "ada", email: "ada@example.com" };
      expect(await upgrade(true, true)).toEqual({ status: 101, asked: 1 });
    });

    it("ends a dashboard admin's conversation once the allow-list drops them", async () => {
      gate.caller = { kind: "visitor", accountId: "ada", email: "ada@example.com" };
      const allowList = { emails: ["ada@example.com"] };
      const http: Server = createServer();
      const voice = attachVoiceConversationServer(http, {} as DrizzleDb, {
        listening: {
          available: () => true,
          info: async () => ({ available: true, place: null }),
          open: async () => ({ ok: false, reason: "service-refused" }),
        },
        speaker: standInSpeaker().source,
        canTalkIn: async () => true,
        send: async () => replyOf(""),
        dashboardAccess: { isCloudEmailAllowed: (email) => allowList.emails.includes(email) },
      });
      await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
      servers.push({ close: () => (voice.close(), http.close()) });
      const client = new WebSocket(
        `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws/voice-conversation`,
      );
      const messages: VoiceConversationServerMessage[] = [];
      client.on("message", (data) => messages.push(JSON.parse(data.toString())));
      const closed = new Promise<void>((resolve) => client.on("close", () => resolve()));
      await new Promise<void>((resolve) => client.on("open", () => resolve()));

      allowList.emails = [];
      client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));

      await closed;
      expect(messages.filter((m) => m.type !== "alive")).toEqual([
        { type: "error", reason: "chat-refused" },
      ]);
    });

    it("follows the chat only for the phone app's conversation", async () => {
      gate.caller = { kind: "visitor", accountId: "ada", email: "ada@example.com" };
      const followedBy = async (headers: Record<string, string>) => {
        const following: string[] = [];
        const ear = standInTranscriber();
        let sent = 0;
        const http: Server = createServer();
        const voice = attachVoiceConversationServer(http, {} as DrizzleDb, {
          listening: {
            available: () => true,
            info: async () => ({ available: true, place: null }),
            open: async () => ({
              ok: true,
              source: { transcriber: ear.transcriber, romeCloudSessionId: "session-1" },
            }),
          },
          speaker: standInSpeaker().source,
          canTalkIn: async () => true,
          send: async () => {
            sent++;
            return replyOf("");
          },
          dashboardAccess: { isCloudEmailAllowed: () => true },
          follow: (owner, chatId) => {
            following.push(`${owner} ${chatId}`);
            return () => {};
          },
        });
        await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
        servers.push({ close: () => (voice.close(), http.close()) });
        const client = new WebSocket(
          `ws://127.0.0.1:${(http.address() as AddressInfo).port}/ws/voice-conversation`,
          { headers },
        );
        const messages: VoiceConversationServerMessage[] = [];
        client.on("message", (data, isBinary) => {
          if (!isBinary) messages.push(JSON.parse(data.toString()));
        });
        await new Promise<void>((resolve) => client.on("open", () => resolve()));
        client.send(JSON.stringify({ type: "start", chatId: "chat-1", sampleRate: 16_000 }));
        await until(() => messages.some((m) => m.type === "ready"), "ready");
        ear.listener().onText("在吗", "");
        ear.listener().onEndpoint?.();
        await until(() => sent === 1, "sent");
        client.close();
        return following;
      };
      expect(await followedBy({ "x-rome-client": "phone" })).toEqual(["visitor:ada chat-1"]);
      // A dashboard's conversation holds back no push, as its watch does not.
      expect(await followedBy({})).toEqual([]);
    });

    it("is not there for the guardian of an account off the voice input list", async () => {
      gate.caller = { kind: "guardian" };
      expect(await upgrade(true, false)).toEqual({ status: 404, asked: 1 });
    });
  });
});
