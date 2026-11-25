import { describe, expect, it } from "@rstest/core";
import type { VoiceConversationServerMessage } from "@rome/api-types/voice-conversation";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { SpeakerError, type SpeakerSession } from "../voice-output/speaker.js";
import {
  createConversation,
  LOOKING_AFTER_MS,
  SPOKEN_TURN_NOTE,
  type ReplyEvent,
  type ReplyTurn,
} from "./conversation.js";

const RATE = 24_000;
/** `ms` of audio at the speaker's rate. */
const audio = (ms: number) => new Uint8Array((RATE * 2 * ms) / 1000);

/** A turn whose events the test pushes. */
function scriptedTurn() {
  const events: ReplyEvent[] = [];
  let ended = false;
  let wake = () => {};
  const turn: ReplyTurn = {
    events: () => ({
      async *[Symbol.asyncIterator]() {
        let next = 0;
        while (true) {
          while (next < events.length) yield events[next++] as ReplyEvent;
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
    push(...more: ReplyEvent[]) {
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
  const inputIds: string[] = [];
  const signals: AbortSignal[] = [];
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
    send: async (text, inputId, signal) => {
      sent.push(text);
      inputIds.push(inputId);
      signals.push(signal);
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
    inputIds,
    signals,
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
    // The client learns which message the turn became, so it can show it until the chat has it.
    expect(t.messages.filter((m) => m.type === "turn")).toEqual([
      { type: "turn", text: "帮我看一下PR 的状态。", inputId: t.inputIds[0] },
    ]);
    expect(t.inputIds[0]).toEqual(expect.any(String));
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

  it("sends an answer begun after Rome stopped, even when it repeats Rome's words", async () => {
    const t = setup();
    t.conversation.heard("订机票", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({
      type: "text_delta",
      content: "明天早上的航班还是下午的航班？Or the staging server or production?",
    });
    t.turns[0]?.end();
    await settled();
    t.speak(0, 1000);
    t.speak(1, 1000);
    // Half a second after the audio ends: an answer, not an echo.
    t.clock.advance(2500);
    t.conversation.heard("下午的航班", "");
    t.conversation.endpoint();
    t.conversation.heard("the staging server", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["订机票", "下午的航班", "the staging server"]);
  });

  it("forgets the words it never played once the guardian speaks over them", async () => {
    const t = setup();
    t.conversation.heard("推荐餐厅", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({
      type: "text_delta",
      content: "第一家是老王饭馆。第二家是江南小厨。第三家是海边餐厅。",
    });
    await settled();
    // Speech runs far ahead of playback.
    for (let i = 0; i < t.said.length; i++) t.speak(i, 10_000);
    t.conversation.heard("停一下", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["推荐餐厅", "停一下"]);

    t.clock.advance(3000);
    t.turns[1]?.push({ type: "text_delta", content: "好的，我停下了。" });
    await settled();
    t.speak(3, 2000);
    // A name from the list Rome never played is the guardian's, not an echo.
    t.conversation.heard("", "海边餐厅");
    expect(t.messages.filter((m) => m.type === "clear")).toHaveLength(2);
  });

  it("sends a short answer right after Rome's question, even when Rome said those words", async () => {
    const t = setup();
    t.conversation.heard("水果", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({ type: "text_delta", content: "你要苹果还是香蕉？Or no fruit now?" });
    t.turns[0]?.end();
    await settled();
    t.speak(0, 1000);
    t.speak(1, 1000);
    t.clock.advance(2500);
    t.conversation.heard("香蕉", "");
    t.conversation.endpoint();
    t.conversation.heard("No", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["水果", "香蕉", "No"]);
  });

  it("knows Rome's own words for as long as their audio may still be heard, however long the reply", async () => {
    const t = setup();
    t.conversation.heard("讲个长故事", "");
    t.conversation.endpoint();
    await settled();
    const first = "第一句话说的是很久很久以前的一座山。";
    const filler = "后面还有很多很多很多很多很多很多很多很多的话要说。";
    t.turns[0]?.push({ type: "text_delta", content: first + filler.repeat(40) });
    await settled();
    // Speech runs far ahead of playback: every sentence is generated at once.
    for (let i = 0; i < t.said.length; i++) t.speak(i, 3000);
    expect(t.said.map((s) => s.text).join("").length).toBeGreaterThan(600);
    // Rome's first sentence still plays, and comes back through the microphone.
    t.conversation.heard("", "很久很久以前的一座山");
    expect(t.messages.filter((m) => m.type === "clear")).toEqual([]);
  });

  it("drops the looking line's echo that is heard only after its audio played", async () => {
    const t = setup();
    t.conversation.heard("查一下天气", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    expect(t.said.map((s) => s.text)).toEqual(["我查一下。"]);
    t.speak(0, 800);
    // Recognition runs behind: the echo's first words come 300 ms after the audio ends.
    t.clock.advance(800 + 300);
    t.conversation.heard("", "我查一下");
    t.conversation.heard("我查一下。", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气"]);
    expect(t.signals[0]?.aborted).toBe(false);

    // The reply starts playing while the next echo is still being heard.
    t.conversation.heard("", "我查一下");
    t.turns[0]?.push({ type: "text_delta", content: "今天晴。" });
    await settled();
    t.speak(1, 1000);
    t.conversation.heard("我查一下。今天晴", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气"]);
    expect(t.signals[0]?.aborted).toBe(false);

    // Once Rome's words can no longer come back, the guardian is heard again.
    t.clock.advance(5000);
    t.conversation.heard("我查一下明天", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气", "我查一下明天"]);
  });

  it("drops an English looking line heard late, but sends part of a sentence as an answer", async () => {
    const t = setup();
    t.conversation.heard("check the build", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    t.speak(0, 700);
    t.clock.advance(700 + 300);
    t.conversation.heard("Let me check.", "");
    t.conversation.endpoint();
    t.conversation.heard("me check", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["check the build", "me check"]);
  });

  it("drops the looking line's late echo while the next sentence waits for its audio", async () => {
    const t = setup();
    t.conversation.heard("查一下天气", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    t.turns[0]?.push({ type: "text_delta", content: "今天晴。" });
    await settled();
    expect(t.said.map((s) => s.text)).toEqual(["我查一下。", "今天晴。"]);
    // The reply's sentence is next to play, but none of its audio has come yet.
    t.speak(0, 800);
    t.clock.advance(800 + 300);
    t.conversation.heard("我查一下。", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气"]);
    expect(t.signals[0]?.aborted).toBe(false);
  });

  it("sends a sentence the guardian says that Rome queued but never played", async () => {
    const t = setup();
    t.conversation.heard("check the build", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    t.turns[0]?.push({ type: "text_delta", content: "Check the logs.\n" });
    await settled();
    t.speak(0, 700);
    t.clock.advance(700 + 300);
    t.conversation.heard("Check the logs.", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["check the build", "Check the logs."]);
  });

  it("keeps a late-begun pick as the guardian's when Rome plays again before the endpoint", async () => {
    const t = setup();
    t.conversation.heard("check the build", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    t.speak(0, 700);
    t.clock.advance(700 + 300);
    t.conversation.heard("", "me check");
    t.turns[0]?.push({ type: "text_delta", content: "The build passed.\n" });
    await settled();
    t.speak(1, 1000);
    t.conversation.heard("me check", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["check the build", "me check"]);
  });

  it("does not take a late echo as speaking over the next sentence, past the echo's own time", async () => {
    const t = setup();
    t.conversation.heard("查一下天气", "");
    t.conversation.endpoint();
    await settled();
    t.clock.advance(LOOKING_AFTER_MS);
    t.turns[0]?.push({ type: "text_delta", content: "今天晴。" });
    await settled();
    t.speak(0, 800);
    // Recognition of the echo begins 1.9 s after its audio ends.
    t.clock.advance(800 + 1900);
    t.conversation.heard("", "我查");
    // The next sentence plays once the looking line could no longer come back.
    t.clock.advance(200);
    t.speak(1, 1000);
    t.conversation.heard("我查一下。", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["查一下天气"]);
    expect(t.signals[0]?.aborted).toBe(false);
  });

  it("forgets a stopped reply's words on time, even when the next reply starts at once", async () => {
    const t = setup();
    t.conversation.heard("deploy it", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({
      type: "text_delta",
      content: "Deploying to the production server now.\nThen I will check the logs.\n",
    });
    await settled();
    t.speak(0, 3000);
    t.speak(1, 3000);
    t.clock.advance(1000);
    t.conversation.heard("wait stop", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["deploy it", "wait stop"]);

    // The next reply plays before the stopped one's words could have stopped coming back.
    t.clock.advance(500);
    t.turns[1]?.push({ type: "text_delta", content: "Okay, stopped.\n" });
    await settled();
    t.speak(2, 4000);
    t.clock.advance(3000);
    t.conversation.heard("the production server", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["deploy it", "wait stop", "the production server"]);
  });

  it("keeps a stopped reply's words for a turn begun in their time, when the next sentence plays after it", async () => {
    const t = setup();
    t.conversation.heard("deploy it", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push({ type: "text_delta", content: "Deploying to the production server now.\n" });
    await settled();
    t.speak(0, 3000);
    t.clock.advance(1000);
    t.conversation.heard("wait stop", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["deploy it", "wait stop"]);

    // The next reply plays, and the stopped reply's echo begins within its time.
    t.clock.advance(500);
    t.turns[1]?.push({ type: "text_delta", content: "Okay, stopped.\nAnything else?\n" });
    await settled();
    t.speak(1, 1000);
    t.clock.advance(300);
    t.conversation.heard("", "the production");
    // The next sentence first plays after the stopped reply's words could come back.
    t.clock.advance(1300);
    t.speak(2, 1000);
    t.conversation.heard("the production server", "");
    t.conversation.endpoint();
    await settled();
    expect(t.sent).toEqual(["deploy it", "wait stop"]);
    expect(t.signals[1]?.aborted).toBe(false);
  });

  it("speaks the messages a private-text agent delivers, and points to the chat once for cards", async () => {
    const t = setup();
    t.conversation.heard("订机票", "");
    t.conversation.endpoint();
    await settled();
    t.turns[0]?.push(
      { type: "said", text: "好的，订好了。" },
      { type: "shown" },
      { type: "said", text: "**航班** 是下午三点" },
      { type: "shown" },
    );
    t.turns[0]?.end();
    await settled();
    expect(t.said.map((s) => s.text)).toEqual([
      "好的，订好了。",
      "详细内容在聊天里。",
      "航班 是下午三点",
    ]);
  });

  it("lets go of a turn it no longer waits for, when the guardian speaks again or hangs up", async () => {
    const t = setup();
    t.conversation.heard("第一句", "");
    t.conversation.endpoint();
    t.conversation.heard("第二句", "");
    t.conversation.endpoint();
    await settled();
    expect(t.signals.map((s) => s.aborted)).toEqual([true, false]);
    t.conversation.close();
    expect(t.signals.map((s) => s.aborted)).toEqual([true, true]);
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

describe("the spoken turn's note", () => {
  it("asks for a secretary's answer on the phone, and no decision by voice on what needs its text", () => {
    for (const rule of [
      "Lead with the conclusion, in one or two",
      "Do not repeat back what they said",
      "do not ask follow-up questions",
      "no headings, lists or other formatting",
      "at most two options",
      "If something went wrong",
      "the details are in the chat",
      "only mentioned on the call",
      "may be made by voice",
    ]) {
      expect(SPOKEN_TURN_NOTE).toContain(rule);
    }
    expect(SPOKEN_TURN_NOTE.startsWith("<voice_context>")).toBe(true);
    expect(SPOKEN_TURN_NOTE.endsWith("</voice_context>")).toBe(true);
  });
});
