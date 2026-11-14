// One dictation: microphone audio goes to Rome's `/ws/voice-input` socket and
// the text comes back while the guardian speaks. Messages are in
// `@rome/api-types/voice-input`.

import {
  VOICE_INPUT_SOCKET_PATH,
  type VoiceInputClientMessage,
  type VoiceInputStopReason,
  voiceInputServerMessageSchema,
} from "@rome/api-types/voice-input";
import { type Microphone, openMicrophone } from "./microphone";

/** Why listening stopped without the guardian's stop action. */
export type DictationStopReason =
  | VoiceInputStopReason
  | "microphone-blocked"
  | "microphone-missing"
  | "microphone-failed"
  | "connection-lost";

/** Why listening stopped, with Rome Cloud's reason code for `service-refused`. */
export interface DictationStop {
  reason: DictationStopReason;
  detail?: string;
}

export interface DictationHandlers {
  /** All the text heard so far, settled and pending, each time it changes. */
  onText(text: string): void;
  /**
   * Called once, last. `text` is everything heard. `stop` is null when the
   * guardian stopped and the provider sent the rest of the text.
   */
  onDone(text: string, stop: DictationStop | null): void;
}

export interface Dictation {
  /** Stops listening and waits for the rest of the text. */
  stop(): void;
  /** Drops the dictation. No handler is called after it. */
  cancel(): void;
}

/** The parts of a browser `WebSocket` a dictation uses, so tests can stand one in. */
export type DictationSocket = Pick<
  WebSocket,
  "send" | "close" | "readyState" | "onopen" | "onmessage" | "onclose" | "onerror"
>;

export interface DictationDeps {
  openMicrophone(onAudio: (chunk: ArrayBuffer) => void): Promise<Microphone>;
  openSocket(): DictationSocket;
}

// After a stop, how long the rest of the text may take before the field keeps
// what it has.
const FINISH_TIMEOUT_MS = 5_000;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${VOICE_INPUT_SOCKET_PATH}`;
}

const browserDeps: DictationDeps = {
  openMicrophone,
  openSocket: () => {
    const socket = new WebSocket(socketUrl());
    socket.binaryType = "arraybuffer";
    return socket;
  },
};

export function startDictation(
  handlers: DictationHandlers,
  deps: DictationDeps = browserDeps,
): Dictation {
  let settled = "";
  let pending = "";
  let done = false;
  let stopping = false;
  // Set once the microphone's last audio has gone out, so `stop` may follow it.
  let audioDone = false;
  let microphone: Microphone | null = null;
  let socket: DictationSocket | null = null;
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  // Audio captured before the socket opens.
  const queued: ArrayBuffer[] = [];

  const heard = () => settled + pending;

  const teardown = () => {
    done = true;
    microphone?.close();
    if (finishTimer) clearTimeout(finishTimer);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    }
  };

  const finish = (reason: DictationStopReason | null, detail?: string) => {
    if (done) return;
    teardown();
    handlers.onDone(heard(), reason ? { reason, ...(detail ? { detail } : {}) } : null);
  };

  const send = (message: VoiceInputClientMessage) => socket?.send(JSON.stringify(message));

  const sendStop = () => {
    if (audioDone && socket?.readyState === WebSocket.OPEN) send({ type: "stop" });
  };

  void deps
    .openMicrophone((chunk) => {
      if (done || audioDone) return;
      if (socket?.readyState === WebSocket.OPEN) socket.send(chunk);
      else queued.push(chunk);
    })
    .then((opened) => {
      if (done) {
        opened.close();
        return;
      }
      microphone = opened;
      if (stopping) {
        // Stopped before the microphone opened: nothing was heard.
        finish(null);
        return;
      }
      socket = deps.openSocket();
      socket.onopen = () => {
        send({ type: "start", sampleRate: opened.sampleRate });
        for (const chunk of queued.splice(0)) socket?.send(chunk);
        sendStop();
      };
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = voiceInputServerMessageSchema.safeParse(parsed);
        if (!message.success) return;
        if (message.data.type === "text") {
          settled += message.data.settled;
          pending = message.data.pending;
          handlers.onText(heard());
        } else if (message.data.type === "ended") {
          finish(null);
        } else {
          finish(message.data.reason, message.data.detail);
        }
      };
      socket.onclose = () => finish(stopping ? null : "connection-lost");
      socket.onerror = () => finish(stopping ? null : "connection-lost");
    })
    .catch((error: unknown) => {
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
    stop() {
      if (done || stopping) return;
      stopping = true;
      // Without a socket nothing was sent, so nothing more can come back. A
      // microphone that opens later is closed by the `done` check.
      if (!socket || !microphone) {
        finish(null);
        return;
      }
      // Whatever Rome and the socket do from here, the field gets its text
      // back within the timeout.
      finishTimer = setTimeout(() => finish(null), FINISH_TIMEOUT_MS);
      void microphone.finish().then(() => {
        audioDone = true;
        sendStop();
      });
    },
    cancel() {
      if (!done) teardown();
    },
  };
}
