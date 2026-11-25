// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { Microphone } from "@/lib/voice-input/microphone";
import {
  type ConversationDeps,
  type ConversationStopReason,
  startVoiceConversation,
} from "./conversation";
import type { PcmPlayer } from "./player";

/** Stands in for Rome's voice conversation socket. */
function fakeSocket() {
  const socket = {
    readyState: 0 as number,
    sent: [] as Array<string | ArrayBuffer>,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    send(data: string | ArrayBuffer) {
      socket.sent.push(data);
    },
    close() {
      socket.readyState = 3;
    },
    open() {
      socket.readyState = 1;
      socket.onopen?.();
    },
    say(message: object) {
      socket.onmessage?.({ data: JSON.stringify(message) });
    },
    text: () =>
      socket.sent.filter((f): f is string => typeof f === "string").map((f) => JSON.parse(f)),
  };
  return socket;
}

function setup(refuse?: string) {
  const socket = fakeSocket();
  let onAudio: (chunk: ArrayBuffer) => void = () => {};
  const played: Array<[number, number]> = [];
  let cleared = 0;
  let closedPlayer = false;
  let ahead = 0;
  const player: PcmPlayer = {
    play: (chunk, rate) => played.push([chunk.byteLength, rate]),
    clear: () => {
      cleared += 1;
    },
    level: () => 0.5,
    ahead: () => ahead,
    close: () => {
      closedPlayer = true;
    },
  };
  let micClosed = false;
  const deps: ConversationDeps = {
    openMicrophone: async (audio) => {
      if (refuse) throw new DOMException("no", refuse);
      onAudio = audio;
      return {
        sampleRate: 16000,
        finish: async () => {},
        close: () => {
          micClosed = true;
        },
        level: () => 0.8,
      } satisfies Microphone;
    },
    openSocket: () => socket as never,
    createPlayer: () => player,
  };
  const states: string[] = [];
  const ended: Array<ConversationStopReason | null> = [];
  const heard: string[] = [];
  const captions: string[] = [];
  const conversation = startVoiceConversation(
    "concierge",
    {
      onState: (s) => states.push(s),
      onEnded: (r) => ended.push(r),
      onHeard: (text) => heard.push(text),
      onCaption: (text) => captions.push(text),
    },
    deps,
  );
  return {
    socket,
    conversation,
    states,
    ended,
    heard,
    captions,
    setAhead: (seconds: number) => {
      ahead = seconds;
    },
    played,
    cleared: () => cleared,
    closedPlayer: () => closedPlayer,
    micClosed: () => micClosed,
    speak: (bytes: number) => onAudio(new ArrayBuffer(bytes)),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => rs.restoreAllMocks());

describe("a voice conversation in the browser", () => {
  it("starts in its chat, sends the microphone, and plays Rome's reply at the rate Rome names", async () => {
    const c = setup();
    await settle();
    c.socket.open();
    expect(c.socket.text()).toEqual([{ type: "start", chatId: "concierge", sampleRate: 16000 }]);
    c.speak(320);
    expect(c.socket.sent.at(-1)).toBeInstanceOf(ArrayBuffer);

    c.socket.say({ type: "ready", sampleRate: 24000 });
    c.socket.say({ type: "state", state: "speaking" });
    c.socket.onmessage?.({ data: new ArrayBuffer(480) });
    expect(c.states).toEqual(["speaking"]);
    expect(c.played).toEqual([[480, 24000]]);
    expect(c.conversation.replyLevel()).toBe(0.5);

    c.socket.say({ type: "clear" });
    expect(c.cleared()).toBe(1);
  });

  it("shows what Rome hears until the turn is sent, and each caption as its audio starts", async () => {
    rs.useFakeTimers();
    try {
      const c = setup();
      await rs.advanceTimersByTimeAsync(0);
      c.socket.open();
      c.socket.say({ type: "ready", sampleRate: 24000 });
      const audio = () => c.socket.onmessage?.({ data: new ArrayBuffer(480) });
      c.socket.say({ type: "heard", settled: "Book a ", pending: "table" });
      c.socket.say({ type: "turn", text: "Book a table" });
      expect(c.heard).toEqual(["Book a table", ""]);
      expect(c.captions).toEqual([""]);

      // A caption waits for its sentence's audio, still being made.
      c.socket.say({ type: "caption", text: "Sure." });
      rs.advanceTimersByTime(500);
      expect(c.captions).toEqual([""]);
      audio();
      rs.advanceTimersByTime(0);
      expect(c.captions).toEqual(["", "Sure."]);

      // The second sentence's audio plays after the first's.
      c.setAhead(1.5);
      c.socket.say({ type: "caption", text: "For how many?" });
      audio();
      rs.advanceTimersByTime(1_400);
      expect(c.captions).toEqual(["", "Sure."]);
      rs.advanceTimersByTime(100);
      expect(c.captions).toEqual(["", "Sure.", "For how many?"]);

      // Rome thinks between sentences: the next caption still shows with its audio.
      c.setAhead(0);
      c.socket.say({ type: "caption", text: "Indoors?" });
      c.socket.say({ type: "state", state: "thinking" });
      audio();
      c.socket.say({ type: "state", state: "speaking" });
      rs.advanceTimersByTime(1_000);
      expect(c.captions).toEqual(["", "Sure.", "For how many?", "Indoors?"]);

      // Speaking over the reply drops the captions not shown yet.
      c.setAhead(1);
      c.socket.say({ type: "caption", text: "Or outside?" });
      audio();
      c.socket.say({ type: "clear" });
      rs.advanceTimersByTime(2_000);
      expect(c.captions).toEqual(["", "Sure.", "For how many?", "Indoors?", ""]);
    } finally {
      rs.useRealTimers();
    }
  });

  it("keeps the last caption until its audio has played here, though Rome already says listening", async () => {
    rs.useFakeTimers();
    try {
      const c = setup();
      await rs.advanceTimersByTimeAsync(0);
      c.socket.open();
      c.socket.say({ type: "ready", sampleRate: 24000 });
      c.socket.say({ type: "caption", text: "Done." });
      c.socket.onmessage?.({ data: new ArrayBuffer(480) });
      rs.advanceTimersByTime(0);
      // Delivered late, all at once: the audio still has 2 s to play when Rome says listening.
      c.setAhead(2);
      c.socket.say({ type: "state", state: "listening" });
      rs.advanceTimersByTime(1_900);
      expect(c.captions).toEqual(["Done."]);
      rs.advanceTimersByTime(100);
      expect(c.captions).toEqual(["Done.", ""]);
    } finally {
      rs.useRealTimers();
    }
  });

  it("drops a caption still waiting when the turn is sent", async () => {
    rs.useFakeTimers();
    try {
      const c = setup();
      await rs.advanceTimersByTimeAsync(0);
      c.socket.open();
      c.socket.say({ type: "ready", sampleRate: 24000 });
      c.setAhead(0.5);
      c.socket.say({ type: "caption", text: "Bye." });
      c.socket.onmessage?.({ data: new ArrayBuffer(480) });
      c.socket.say({ type: "caption", text: "See you." });
      c.socket.say({ type: "turn", text: "Wait" });
      c.socket.onmessage?.({ data: new ArrayBuffer(480) });
      rs.advanceTimersByTime(1_000);
      expect(c.captions).toEqual([""]);
    } finally {
      rs.useRealTimers();
    }
  });

  it("sends no audio while muted", async () => {
    const c = setup();
    await settle();
    c.socket.open();
    c.conversation.setMuted(true);
    const before = c.socket.sent.length;
    c.speak(320);
    expect(c.socket.sent.length).toBe(before);
    expect(c.conversation.micLevel()).toBe(0);
    c.conversation.setMuted(false);
    c.speak(320);
    expect(c.socket.sent.length).toBe(before + 1);
  });

  it("ends when the guardian ends it, telling Rome and letting go of the microphone and the speaker", async () => {
    const c = setup();
    await settle();
    c.socket.open();
    c.conversation.end();
    expect(c.socket.text().at(-1)).toEqual({ type: "stop" });
    expect(c.ended).toEqual([null]);
    expect(c.micClosed()).toBe(true);
    expect(c.closedPlayer()).toBe(true);
  });

  it("gives the socket 10 s to open, then 3 s of quiet from Rome", async () => {
    rs.useFakeTimers();
    try {
      const c = setup();
      await rs.advanceTimersByTimeAsync(0);
      rs.advanceTimersByTime(9_000);
      expect(c.ended).toEqual([]);
      c.socket.open();
      rs.advanceTimersByTime(2_500);
      c.socket.say({ type: "alive" });
      rs.advanceTimersByTime(2_500);
      expect(c.ended).toEqual([]);
      rs.advanceTimersByTime(600);
      expect(c.ended).toEqual(["connection-lost"]);

      const slow = setup();
      await rs.advanceTimersByTimeAsync(0);
      rs.advanceTimersByTime(10_000);
      expect(slow.ended).toEqual(["connection-lost"]);
    } finally {
      rs.useRealTimers();
    }
  });

  it("ends with Rome's reason, or the microphone's", async () => {
    const c = setup();
    await settle();
    c.socket.open();
    c.socket.say({ type: "error", reason: "chat-refused" });
    expect(c.ended).toEqual(["chat-refused"]);

    const blocked = setup("NotAllowedError");
    await settle();
    expect(blocked.ended).toEqual(["microphone-blocked"]);
  });
});
