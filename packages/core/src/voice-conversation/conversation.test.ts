import { describe, expect, it } from "@rstest/core";
import type { VoiceConversationServerMessage } from "@rome/api-types/voice-conversation";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { SpeakerError, type SpeakerSession } from "../voice-output/speaker.js";
import { createConversation, LOOKING_AFTER_MS, type ReplyTurn } from "./conversation.js";

const RATE = 24_000;
/** `ms` of audio at the speaker's rate. */
const audio = (ms: number) => new Uint8Array((RATE * 2 * ms) / 1000);

/** A turn whose events the test pushes. */
function scriptedTurn() {
  const events: StreamAgentEvent[] = [];
  let ended = false;
  let wake = () => {};
  const turn: ReplyTurn = {
    events: () => ({
      async *[Symbol.asyncIterator]() {
        let next = 0;
        while (true) {
          while (next < events.length) yield events[next++] as StreamAgentEvent;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    }),
  };
  return {
    turn,
    push(...more: StreamAgentEvent[]) {
      events.push(...more);
      wake();
    },
    end() {
      ended = true;
      wake();
    },
  };
}

function setup() {
  let at = 0;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock = {
    now: () => at,
    schedule: (ms: number, fn: () => void) => {
      const timer = { at: at + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance(ms: number) {
      const until = at + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        at = Math.max(at, due.at);
        due.fn();
      }
      at = until;
    },
  };
  const messages: VoiceConversationServerMessage[] = [];
  const played: number[] = [];
  const sent: string[] = [];
  const turns: ReturnType<typeof scriptedTurn>[] = [];
  const said: { id: string; text: string }[] = [];
  let stops = 0;
  let failed: string | null = null;
  const speaker: SpeakerSession = {
    format: { encoding: "pcm_s16le", sampleRate: RATE },
    say: (id, text) => said.push({ id, text }),
    stop: () => {
      stops++;
      return [];
    },
    close: () => {},
  };
  const conversation = createConversation({
    send: async (text) => {
      sent.push(text);
      const turn = scriptedTurn();
      turns.push(turn);
      return turn.turn;
    },
    message: (m) => messages.push(m),
    audio: (pcm) => played.push(pcm.byteLength),
    fail: (reason) => {
      failed = reason;
    },
    schedule: clock.schedule,
    now: clock.now,
  });
  conversation.attach(speaker);
  const states = () =>
    messages.filter((m) => m.type === "state").map((m) => (m as { state: string }).state);
  /** The provider speaks sentence `index` in full. */
  const speak = (index: number, ms = 1000) => {
    const sentence = said[index];
    if (!sentence) throw new Error(`no sentence ${index}`);
    conversation.speakerListener.onAudio({
      sentenceId: sentence.id,
      streamId: "s",
      pcm: audio(ms),
    });
    conversation.speakerListener.onSentenceEnd(sentence.id);
  };
  return {
    clock,
    conversation,
    messages,
    played,
    sent,
    turns,
    said,
    states,
    speak,
    stops: () => stops,
    failed: () => failed,
  };
}

// Lets the conversation read what the turn has.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("voice conversation", () => {
  it("sends a finished turn, speaks the reply sentence by sentence, then listens", async () => {
    const t = setup();
    t.conversation.heard("帮我看一下", "PR");
    t.conversation.heard("PR 的状态。", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["帮我看一下PR 的状态。"]);
    expect(t.states()).toEqual(["thinking"]);

    t.turns[0]?.push(
      { type: "turn_start", turnId: "t1", agent: "core:main" } as StreamAgentEvent,
      { type: "text_delta", content: "好的。已经", agent: "core:main" },
      { type: "text_delta", content: "合并了。", agent: "core:main" },
      { type: "text", content: "好的。已经合并了。", agent: "core:main" },
    );
    t.turns[0]?.end();
    await settled();
    expect(t.said.map((s) => s.text)).toEqual(["好的。", "已经合并了。"]);

    t.speak(0);
    t.speak(1, 500);
    expect(t.messages.filter((m) => m.type === "caption")).toEqual([
      { type: "caption", text: "好的。" },
      { type: "caption", text: "已经合并了。" },
    ]);
    expect(t.played).toEqual([audio(1000).byteLength, audio(500).byteLength]);
    expect(t.states()).toEqual(["thinking", "speaking"]);
    // Listening again once the audio sent has played.
    t.clock.advance(1500);
    expect(t.states()).toEqual(["thinking", "speaking", "listening"]);
  });

  it("plays sentences in order even when a later one's audio comes first", async () => {
    const t = setup();
    t.conversation.heard("说两句", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({ type: "text_delta", content: "第一句。第二句。" });
    await settled();
    const [first, second] = t.said;
    if (!first || !second) throw new Error("expected two sentences");
    t.conversation.speakerListener.onAudio({
      sentenceId: second.id,
      streamId: "b",
      pcm: audio(200),
    });
    expect(t.played).toEqual([]);
    t.conversation.speakerListener.onAudio({
      sentenceId: first.id,
      streamId: "a",
      pcm: audio(100),
    });
    t.conversation.speakerListener.onSentenceEnd(first.id);
    expect(t.played).toEqual([audio(100).byteLength, audio(200).byteLength]);
  });

  it("stops speaking at once when the guardian speaks over the reply", async () => {
    const t = setup();
    t.conversation.heard("讲个故事", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({ type: "text_delta", content: "从前有座山。山里有座庙。" });
    await settled();
    t.speak(0, 3000);
    expect(t.states().at(-1)).toBe("speaking");

    // Too few words, or Rome's own words coming back, are not speaking over it.
    t.conversation.heard("", "嗯");
    t.conversation.heard("", "从前有座山");
    expect(t.stops()).toBe(0);

    t.conversation.heard("", "停一下");
    expect(t.stops()).toBe(1);
    expect(t.messages.at(-2)).toEqual({ type: "clear" });
    expect(t.states().at(-1)).toBe("listening");
    // The rest of the reply is not spoken.
    t.turns[0]?.push({ type: "text_delta", content: "庙里有个老和尚。" });
    await settled();
    expect(t.said).toHaveLength(2);

    t.conversation.heard("停一下", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["讲个故事", "停一下"]);
  });

  it("drops a turn that is only Rome's own words coming back", async () => {
    const t = setup();
    t.conversation.heard("你好", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({ type: "text_delta", content: "你好呀，有什么事？" });
    await settled();
    t.speak(0, 2000);
    t.conversation.heard("有什么事", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["你好"]);
  });

  it("drops Rome's own words heard just after they played, but not the same words said later", async () => {
    const t = setup();
    t.conversation.heard("查一下天气", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    t.speak(0, 500);
    // Recognition lags: the looking line comes back after its audio played.
    t.clock.advance(1000);
    expect(t.states().at(-1)).toBe("thinking");
    t.conversation.heard("我查一下", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气"]);

    t.clock.advance(3000);
    t.conversation.heard("我查一下", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气", "我查一下"]);
  });

  it("says once that it is looking when the agent works quietly for 2 s", async () => {
    const t = setup();
    t.conversation.heard("查一下天气", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS - 1);
    expect(t.said).toEqual([]);
    t.clock.advance(1);
    expect(t.said.map((s) => s.text)).toEqual(["我查一下。"]);
    t.speak(0, 500);
    t.clock.advance(5000);
    expect(t.said).toHaveLength(1);

    t.turns[0]?.push({ type: "text_delta", content: "今天晴。" });
    t.turns[0]?.end();
    await settled();
    expect(t.said.map((s) => s.text)).toEqual(["我查一下。", "今天晴。"]);
  });

  it("says what came before a tool call before the call, and needs no looking line after it", async () => {
    const t = setup();
    t.conversation.heard("check the build", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push(
      { type: "text_delta", content: "Checking it now" },
      { type: "tool_use", id: "c1", tool: "Bash", input: {} },
    );
    await settled();
    expect(t.said.map((s) => s.text)).toEqual(["Checking it now"]);
    t.speak(0, 500);
    t.clock.advance(500 + LOOKING_AFTER_MS);
    expect(t.said.map((s) => s.text)).toEqual(["Checking it now"]);
  });

  it("looks in the language the guardian spoke", async () => {
    const t = setup();
    t.conversation.heard("check the build", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    expect(t.said.map((s) => s.text)).toEqual(["Let me check."]);
  });

  it("says something went wrong when the turn fails before saying anything", async () => {
    const t = setup();
    t.conversation.heard("你好", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({ type: "error", error: "model unavailable" });
    t.turns[0]?.end();
    await settled();
    expect(t.said.map((s) => s.text)).toEqual(["出了点问题，详细内容在聊天里。"]);
  });

  it("ends the conversation when speaking stops or the chat refuses the turn", async () => {
    const t = setup();
    t.conversation.speakerListener.onClosed(new SpeakerError("unauthorized", "refused"));
    expect(t.failed()).toBe("speaking-failed");

    const refused = createConversation({
      send: async () => {
        throw new Error("Session not found");
      },
      message: () => {},
      audio: () => {},
      fail: (reason) => reasons.push(reason),
    });
    const reasons: string[] = [];
    refused.heard("你好", "");
    refused.endpoint();
    await settled();
    expect(reasons).toEqual(["chat-refused"]);
  });
});
