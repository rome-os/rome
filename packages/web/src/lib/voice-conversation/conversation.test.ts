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
  const player: PcmPlayer = {
    play: (chunk, rate) => played.push([chunk.byteLength, rate]),
    clear: () => {
      cleared += 1;
    },
    level: () => 0.5,
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
  const unsent: string[] = [];
  const conversation = startVoiceConversation(
    "concierge",
    {
      onState: (s) => states.push(s),
      onEnded: (r, words) => {
        ended.push(r);
        unsent.push(words);
      },
    },
    deps,
  );
  return {
    socket,
    conversation,
    states,
    ended,
    unsent,
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

  it("hands back the words Rome heard and never sent, but not while Rome speaks", async () => {
    const c = setup();
    await settle();
    c.socket.open();
    c.socket.say({ type: "heard", settled: "Book a table", pending: "" });
    c.socket.say({ type: "turn", text: "Book a table" });
    c.socket.say({ type: "heard", settled: "for four ", pending: "at seven" });
    c.conversation.end();
    expect(c.unsent).toEqual(["for four at seven"]);

    // While Rome speaks, what is heard may be its own voice.
    const speaking = setup();
    await settle();
    speaking.socket.open();
    speaking.socket.say({ type: "state", state: "speaking" });
    speaking.socket.say({ type: "heard", settled: "Sure, for", pending: "" });
    speaking.conversation.end();
    expect(speaking.unsent).toEqual([""]);

    // A conversation that stops on its own hands them back too.
    const lost = setup();
    await settle();
    lost.socket.open();
    lost.socket.say({ type: "heard", settled: "", pending: "Remind me" });
    lost.socket.onclose?.();
    expect(lost.ended).toEqual(["connection-lost"]);
    expect(lost.unsent).toEqual(["Remind me"]);
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
