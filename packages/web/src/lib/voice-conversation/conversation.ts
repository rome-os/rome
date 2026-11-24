// One voice conversation: microphone audio goes to Rome's
// `/ws/voice-conversation` socket, and Rome sends back its state and the
// reply's audio. Rome does the listening, the turns and the speaking; the
// page only records and plays. Messages are in
// `@rome/api-types/voice-conversation`.

import {
  VOICE_CONVERSATION_ALIVE_INTERVAL_MS,
  VOICE_CONVERSATION_SOCKET_PATH,
  type VoiceConversationClientMessage,
  type VoiceConversationState,
  voiceConversationServerMessageSchema,
  voiceConversationStopReasonSchema,
} from "@rome/api-types/voice-conversation";
import { z } from "zod";
import { type Microphone, openMicrophone } from "@/lib/voice-input/microphone";
import { createPcmPlayer, type PcmPlayer } from "./player";

/** Why a conversation ended without the guardian's end. */
export const conversationStopReasonSchema = z.enum([
  ...voiceConversationStopReasonSchema.options,
  "microphone-blocked",
  "microphone-missing",
  "microphone-failed",
  "connection-lost",
]);
export type ConversationStopReason = z.infer<typeof conversationStopReasonSchema>;

export interface ConversationHandlers {
  /** Rome's state changed: listening, thinking or speaking. */
  onState(state: VoiceConversationState): void;
  /** Called once, last. `reason` is null when the guardian ended it. */
  onEnded(reason: ConversationStopReason | null): void;
  /** True while the browser asks the guardian for the microphone, false once answered. */
  onAsking?(asking: boolean): void;
  /** What Rome has heard of the guardian's turn, not sent yet. Empty once the turn is sent. */
  onHeard?(text: string): void;
  /**
   * The reply's sentence playing now, as its audio starts. Empty once the
   * reply's audio has played here, or the guardian speaks over it.
   */
  onCaption?(text: string): void;
}

export interface VoiceConversation {
  /** Ends the conversation. `onEnded` follows with null. */
  end(): void;
  /** While muted, no microphone audio leaves the page. */
  setMuted(muted: boolean): void;
  /** The microphone's loudness from 0 to 1. */
  micLevel(): number;
  /** The reply's loudness from 0 to 1, while it plays. */
  replyLevel(): number;
}

/** The parts of a browser `WebSocket` a conversation uses, so tests can stand one in. */
export type ConversationSocket = Pick<
  WebSocket,
  "send" | "close" | "readyState" | "onopen" | "onmessage" | "onclose" | "onerror"
>;

export interface ConversationDeps {
  openMicrophone(onAudio: (chunk: ArrayBuffer) => void, onAsk?: () => void): Promise<Microphone>;
  openSocket(): ConversationSocket;
  createPlayer(): PcmPlayer;
}

// Silence from Rome this long means the connection is gone: Rome says it is
// there every second while the socket is open.
const QUIET_LIMIT_MS = VOICE_CONVERSATION_ALIVE_INTERVAL_MS * 3;
// Opening the socket may take longer on a slow mobile network, so it gets
// this long before the quiet limit applies.
const OPEN_LIMIT_MS = 10_000;

// The socket states `WebSocket.CONNECTING` and `WebSocket.OPEN`, without needing the global.
const CONNECTING = 0;
const OPEN = 1;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${VOICE_CONVERSATION_SOCKET_PATH}`;
}

const browserDeps: ConversationDeps = {
  openMicrophone,
  openSocket: () => {
    const socket = new WebSocket(socketUrl());
    socket.binaryType = "arraybuffer";
    return socket;
  },
  createPlayer: createPcmPlayer,
};

/** Starts a voice conversation in `chatId`. Call it from the guardian's click, so the reply may play. */
export function startVoiceConversation(
  chatId: string,
  handlers: ConversationHandlers,
  deps: ConversationDeps = browserDeps,
): VoiceConversation {
  let done = false;
  let muted = false;
  let microphone: Microphone | null = null;
  let socket: ConversationSocket | null = null;
  // Opened now, from the guardian's click, so the browser lets it play.
  const player = deps.createPlayer();
  // The reply's sample rate, once Rome names it.
  let sampleRate = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  // Each caption waits for the audio queued before its sentence. The last one
  // stays until the audio queued here has played: Rome's state follows the
  // audio it sent, which can be well ahead after a network stall.
  const captionTimers = new Set<ReturnType<typeof setTimeout>>();
  let captionEnd: ReturnType<typeof setTimeout> | null = null;
  const stopCaptionEnd = () => {
    if (captionEnd) clearTimeout(captionEnd);
    captionEnd = null;
  };
  const clearCaptions = () => {
    for (const timer of captionTimers) clearTimeout(timer);
    captionTimers.clear();
    stopCaptionEnd();
  };
  // A caption comes before its sentence's audio, which plays after the audio queued so far.
  const captionWhenPlayed = (text: string) => {
    stopCaptionEnd();
    const timer = setTimeout(() => {
      captionTimers.delete(timer);
      handlers.onCaption?.(text);
    }, player.ahead() * 1000);
    captionTimers.add(timer);
  };
  const stateChanged = (state: VoiceConversationState) => {
    handlers.onState(state);
    if (state === "speaking") return;
    stopCaptionEnd();
    captionEnd = setTimeout(() => {
      captionEnd = null;
      handlers.onCaption?.("");
    }, player.ahead() * 1000);
  };
  // The guardian's turn went to the chat: its words leave the page, and the last reply's too.
  const turnSent = () => {
    clearCaptions();
    handlers.onHeard?.("");
    handlers.onCaption?.("");
  };
  // The guardian spoke over the reply: what has not played goes, and its words with it.
  const dropUnplayed = () => {
    player.clear();
    clearCaptions();
    handlers.onCaption?.("");
  };

  const teardown = () => {
    done = true;
    microphone?.close();
    player.close();
    clearCaptions();
    if (quietTimer) clearTimeout(quietTimer);
    window.removeEventListener("offline", lost);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState === CONNECTING || socket.readyState === OPEN) {
        socket.close();
      }
    }
  };
  const finish = (reason: ConversationStopReason | null) => {
    if (done) return;
    teardown();
    handlers.onEnded(reason);
  };
  function lost() {
    finish("connection-lost");
  }
  const heardFromRome = (limit = QUIET_LIMIT_MS) => {
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(lost, limit);
  };
  window.addEventListener("offline", lost);
  const send = (message: VoiceConversationClientMessage) => socket?.send(JSON.stringify(message));

  let asking = false;
  void deps
    .openMicrophone(
      (chunk) => {
        if (done || muted) return;
        if (socket?.readyState === OPEN) socket.send(chunk);
      },
      () => {
        if (done) return;
        asking = true;
        handlers.onAsking?.(true);
      },
    )
    .then((opened) => {
      if (asking) handlers.onAsking?.(false);
      if (done) {
        opened.close();
        return;
      }
      microphone = opened;
      socket = deps.openSocket();
      heardFromRome(OPEN_LIMIT_MS);
      socket.onopen = () => {
        heardFromRome();
        send({ type: "start", chatId, sampleRate: opened.sampleRate });
      };
      socket.onmessage = (event: MessageEvent) => {
        heardFromRome();
        if (typeof event.data !== "string") {
          if (event.data instanceof ArrayBuffer && sampleRate) player.play(event.data, sampleRate);
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = voiceConversationServerMessageSchema.safeParse(parsed);
        if (!message.success) return;
        const data = message.data;
        if (data.type === "ready") sampleRate = data.sampleRate;
        else if (data.type === "state") stateChanged(data.state);
        else if (data.type === "heard") handlers.onHeard?.(`${data.settled}${data.pending}`);
        else if (data.type === "turn") turnSent();
        else if (data.type === "caption") captionWhenPlayed(data.text);
        else if (data.type === "clear") dropUnplayed();
        else if (data.type === "ended") finish(null);
        else if (data.type === "error") finish(data.reason);
      };
      socket.onclose = () => finish("connection-lost");
      socket.onerror = () => finish("connection-lost");
    })
    .catch((error: unknown) => {
      if (asking) handlers.onAsking?.(false);
      const name = error instanceof DOMException ? error.name : "";
      finish(
        name === "NotAllowedError" || name === "SecurityError"
          ? "microphone-blocked"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "microphone-missing"
            : "microphone-failed",
      );
    });

  return {
    end() {
      if (done) return;
      if (socket?.readyState === OPEN) send({ type: "stop" });
      finish(null);
    },
    setMuted(next) {
      muted = next;
    },
    micLevel() {
      return done || muted || !microphone ? 0 : microphone.level();
    },
    replyLevel() {
      return done ? 0 : player.level();
    },
  };
}
