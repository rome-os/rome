// The voice conversation socket. The client streams microphone audio up and
// plays what comes down. Rome listens on a transcription stream with endpoint
// detection, and `conversation.ts` sends each turn to the chat and speaks the
// reply. Messages are in `@rome/api-types/voice-conversation`. Only the
// team may connect, and only while Rome Cloud lets the guardian's account use
// voice input. A person dropped from the allow-list loses the conversation
// before anything more they say is taken, or at the next recheck. Rome keeps
// no audio: frames go straight to the provider.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import {
  VOICE_CONVERSATION_ALIVE_INTERVAL_MS,
  VOICE_CONVERSATION_SOCKET_PATH,
  type VoiceConversationServerMessage,
  type VoiceConversationStopReason,
  voiceConversationClientMessageSchema,
} from "@rome/api-types/voice-conversation";
import { LIVE_EVENTS_CLIENT_HEADER, PHONE_CLIENT } from "@rome/api-types/live-events";
import { mayEnter, holdEntry } from "../access/entry.js";
import {
  runWithSessionActor,
  type SessionActor,
  sessionOwnerKey,
} from "../access/session-actor.js";
import type { DashboardAllowList } from "../access/team.js";
import { gateUpgrade } from "../access/ws-guardian-gate.js";
import type { DrizzleDb } from "../db/index.js";
import { rejectUpgrade } from "../lib/ws-upgrade.js";
import { createLogger } from "../logger.js";
import type { TranscriptionUsageSink } from "../usage/recorder.js";
import type { TranscriptionStream } from "../voice-input/transcriber.js";
import type { ListeningSource, VoiceInputSource } from "../voice-input/voice-input-source.js";
import { readVoiceTerms } from "../voice-input/voice-terms.js";
import type { SpeakerSource } from "../voice-output/speaker-source.js";
import { createConversation, type ReplyTurn } from "./conversation.js";

const log = createLogger("voice-conversation");

// A 16 kHz mono frame of a few hundred milliseconds is about 10 KB.
const MAX_FRAME_BYTES = 256 * 1024;
// Bounds what one forgotten conversation costs. Rome Cloud's listening session lasts no longer.
const MAX_CONVERSATION_MS = 30 * 60 * 1000;
// A microphone delivers audio no faster than real time. The slack covers
// frames that arrive in a burst after a network stall.
const AUDIO_SLACK_MS = 5_000;

export interface VoiceConversationDeps {
  /** Where listening sessions come from: the same Rome Cloud sessions dictation uses. */
  listening: Pick<VoiceInputSource, "open">;
  speaker: SpeakerSource;
  /** Whether `chatId` can take spoken turns from the ambient session actor, asked before any session opens. */
  canTalkIn(chatId: string): Promise<boolean>;
  /** Sends the speaker's turn into `chatId` as the message `inputId`, and resolves with the turn that answers it. `signal` aborts once the conversation stops waiting. */
  send(chatId: string, text: string, inputId: string, signal: AbortSignal): Promise<ReplyTurn>;
  usage?: TranscriptionUsageSink | null;
  voiceTerms?: () => Promise<string[]>;
  maxConversationMs?: number;
  /**
   * Counts the person as following `chatId`, as their phone showing it does:
   * the Concierge does not push what it says there. Held only while the reply
   * to a spoken turn is read, since they hear that, and released after:
   * what else the chat gets pushes as usual. Returns the release. `owner` is
   * their chat owner key. Only a phone's conversation follows, as only a
   * phone's live-events socket watches.
   */
  follow?: (owner: string, chatId: string) => () => void;
  /**
   * Whether the person on the socket is still on the team. Asked before any
   * session opens, before anything the client sends is taken, before each
   * turn, and every 25 s, and the conversation ends with `chat-refused` once it
   * answers false. Default: always on the team.
   */
  onTeam?: () => Promise<boolean>;
}

/**
 * Serves `/ws/voice-conversation` to the team while Rome Cloud lets the
 * guardian's account use voice input, the list the microphone follows.
 * Otherwise the path answers 404, as no client offers the conversation. Rome
 * Cloud is asked only once the caller is proven to be on the team.
 */
export function attachVoiceConversationServer(
  httpServer: Server,
  db: DrizzleDb,
  deps: VoiceConversationDeps & {
    listening: Pick<VoiceInputSource, "open" | "info" | "available">;
    dashboardAccess: DashboardAllowList;
  },
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== VOICE_CONVERSATION_SOCKET_PATH) return;
    socket.on("error", () => socket.destroy());
    // Not signed in to Rome Cloud: no voice at all, known without asking it.
    if (!deps.listening.available()) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    void gateUpgrade(req, socket, db, deps.dashboardAccess)
      .then(async (actor) => {
        if (!actor || socket.destroyed) return;
        // Only now, for a proven team member, ask Rome Cloud's list.
        const { available } = await deps.listening.info();
        if (socket.destroyed) return;
        if (!available) return rejectUpgrade(socket, 404, "Not Found");
        const onTeam = async () => (await mayEnter(actor, deps.dashboardAccess)) !== null;
        // The phone app marks its sockets as it marks its live-events socket.
        const { follow, ...rest } = deps;
        const phone = req.headers[LIVE_EVENTS_CLIENT_HEADER] === PHONE_CLIENT;
        const served = { ...rest, onTeam, ...(phone && follow ? { follow } : {}) };
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, served, actor));
      })
      .catch((err) => {
        log.error("voice conversation upgrade failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
  });

  return {
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

/** Runs one conversation over `ws`, for `actor`. Exported for tests. */
export function serve(ws: WebSocket, deps: VoiceConversationDeps, actor?: SessionActor): void {
  let closed = false;
  let starting = false;
  let stream: TranscriptionStream | null = null;
  let listening: { source: ListeningSource; sampleRate: number; startedAt: number } | null = null;
  // Audio that came while listening opened, in order.
  const early: Uint8Array[] = [];
  let pace: { since: number; sampleRate: number } | null = null;
  let bytes = 0;
  let alive: ReturnType<typeof setInterval> | null = null;
  let limit: ReturnType<typeof setTimeout> | null = null;
  // Each spoken turn's hold on the chat, until its reply is read.
  const following = new Set<() => void>();
  let chatId: string | null = null;

  const reply = (message: VoiceConversationServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  // Holds `chatId` as followed for the person, once, until the release.
  const follow = (to: string): (() => void) => {
    const owner = sessionOwnerKey(actor);
    if (!owner || !deps.follow) return () => {};
    const stop = deps.follow(owner, to);
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      following.delete(release);
      stop();
    };
    following.add(release);
    return release;
  };

  const conversation = createConversation({
    send: async (text, inputId, signal) => {
      const to = chatId;
      if (!to) throw new Error("no chat");
      if (!(await entry.holds())) throw new Error("may not enter");
      // They hear this turn's reply: the Concierge does not also push it.
      const release = follow(to);
      signal.addEventListener("abort", release, { once: true });
      const sent = actor
        ? runWithSessionActor(actor, () => deps.send(to, text, inputId, signal))
        : deps.send(to, text, inputId, signal);
      return sent.then(
        (turn) => heardThrough(turn, release),
        (err: unknown) => {
          release();
          throw err;
        },
      );
    },
    message: (message) => {
      if (!closed) reply(message);
    },
    audio: (pcm) => {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(pcm, { binary: true });
    },
    fail: (reason) => close({ type: "error", reason }),
  });

  // Every listening session is a Rome Cloud session, so each one reports.
  const reportUsage = (status: string) => {
    if (!listening || !deps.usage) return;
    const { transcriber, romeCloudSessionId } = listening.source;
    deps.usage.recordTranscription({
      sessionId: romeCloudSessionId,
      provider: transcriber.providerId,
      model: transcriber.model,
      // PCM s16le mono: two bytes a sample. Only what reached the provider.
      seconds: Math.round(((stream?.sentBytes ?? 0) / 2 / listening.sampleRate) * 10) / 10,
      status,
      durationMs: Date.now() - listening.startedAt,
    });
  };

  const settle = (outcome: string) => {
    for (const release of [...following]) release();
    entry.release();
    if (alive) clearInterval(alive);
    if (limit) clearTimeout(limit);
    conversation.close();
    stream?.abort();
    log.info("voice conversation ended", { outcome, bytes });
    reportUsage(outcome);
  };

  function close(last: VoiceConversationServerMessage) {
    if (closed) return;
    closed = true;
    reply(last);
    ws.close(1000);
    settle(last.type === "error" ? last.reason : last.type);
  }
  const fail = (reason: VoiceConversationStopReason) => close({ type: "error", reason });
  const entry = holdEntry(deps.onTeam ?? (async () => true), () => fail("chat-refused"));

  // Counts one frame, or ends the conversation when the client sends audio
  // faster than a microphone records it.
  const accept = (chunk: Uint8Array): boolean => {
    if (!pace) return false;
    const allowed = (pace.sampleRate * 2 * (Date.now() - pace.since + AUDIO_SLACK_MS)) / 1000;
    if (bytes + chunk.byteLength > allowed) {
      fail("bad-request");
      return false;
    }
    bytes += chunk.byteLength;
    return true;
  };

  async function begin(sampleRate: number) {
    starting = true;
    // A chat that cannot take spoken turns is refused before any paid session opens.
    const to = chatId;
    if (!to) return fail("chat-refused");
    const canTalk = actor
      ? await runWithSessionActor(actor, () => deps.canTalkIn(to))
      : await deps.canTalkIn(to);
    if (!canTalk) return fail("chat-refused");
    if (closed) return;
    const spoken = await deps.speaker.open(conversation.speakerListener);
    if (closed) {
      if (spoken.ok) spoken.session.close();
      return;
    }
    if (!spoken.ok) {
      log.warn("voice conversation cannot speak", { reason: spoken.reason });
      return fail(spoken.reason === "not-configured" ? "unavailable" : "speaking-failed");
    }
    conversation.attach(spoken.session);
    const [opened, terms] = await Promise.all([
      deps.listening.open(),
      Promise.resolve()
        .then(() => (deps.voiceTerms ?? readVoiceTerms)())
        .catch(() => [] as string[]),
    ]);
    starting = false;
    if (closed) return;
    if (!opened.ok) {
      log.warn("voice conversation cannot listen", { reason: opened.reason });
      return fail("listening-failed");
    }
    listening = { source: opened.source, sampleRate, startedAt: Date.now() };
    stream = opened.source.transcriber.open(
      { sampleRate, mode: "conversation", ...(terms.length ? { terms } : {}) },
      {
        onText: (settled, pending) => conversation.heard(settled, pending),
        onEndpoint: () => conversation.endpoint(),
        onEnd: () => close({ type: "ended" }),
        onFailure: (failure, detail) => {
          log.warn("voice conversation provider failed", { failure, detail });
          fail(failure === "expired" ? "time-limit" : "listening-failed");
        },
      },
    );
    for (const chunk of early.splice(0)) stream.sendAudio(chunk);
    limit = setTimeout(() => fail("time-limit"), deps.maxConversationMs ?? MAX_CONVERSATION_MS);
    log.info("voice conversation started", {
      sessionId: opened.source.romeCloudSessionId,
      sampleRate,
      termCount: terms.length,
    });
    reply({ type: "ready", sampleRate: spoken.session.format.sampleRate });
    reply({ type: "state", state: "listening" });
  }

  const take = (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      if (!starting && !stream) return fail("bad-request");
      const chunk = toBytes(data);
      if (!accept(chunk)) return;
      if (stream) stream.sendAudio(chunk);
      else early.push(chunk);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return fail("bad-request");
    }
    const message = voiceConversationClientMessageSchema.safeParse(parsed);
    if (!message.success) return fail("bad-request");
    if (message.data.type === "stop") return close({ type: "ended" });
    if (starting || stream) return fail("bad-request");
    chatId = message.data.chatId;
    pace = { since: Date.now(), sampleRate: message.data.sampleRate };
    alive = setInterval(() => reply({ type: "alive" }), VOICE_CONVERSATION_ALIVE_INTERVAL_MS);
    void begin(message.data.sampleRate).catch((err: unknown) => {
      log.error("voice conversation could not start", {
        error: err instanceof Error ? err.message : String(err),
      });
      fail("listening-failed");
    });
  };
  ws.on("message", (data: RawData, isBinary) => entry.admit(() => take(data, isBinary)));

  ws.on("close", () => {
    if (closed) return;
    closed = true;
    settle("client-closed");
  });
  ws.on("error", () => ws.terminate());
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/** `turn`, releasing `release` once its reply has been read to the end or left. */
function heardThrough(turn: ReplyTurn, release: () => void): ReplyTurn {
  return {
    ...turn,
    events: () => releasing(turn.events(), release),
  };
}

async function* releasing<T>(events: AsyncIterable<T>, release: () => void): AsyncGenerator<T> {
  try {
    yield* events;
  } finally {
    release();
  }
}
