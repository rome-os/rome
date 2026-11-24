import { describe, expect, it } from "@rstest/core";
import type { VoiceConversationServerMessage } from "@rome/api-types/voice-conversation";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { SpeakerError, type SpeakerSession } from "../voice-output/speaker.js";
import {
  createConversation,
  LOOKING_AFTER_MS,
  OFFER_AFTER_QUIET_MS,
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

function setup(options: { nameOf?: (messageId: string) => Promise<string | null> } = {}) {
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
  const notes: (string | undefined)[] = [];
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
    send: async (text, signal, note) => {
      sent.push(text);
      notes.push(note);
      signals.push(signal);
      const turn = scriptedTurn();
      turns.push(turn);
      return { ...turn.turn, id: `spoken-${turns.length}` };
    },
    ...(options.nameOf ? { nameOf: options.nameOf } : {}),
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
    notes,
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

describe("late messages in a voice conversation", () => {
  /** A message the Concierge adds outside the guardian's spoken turns. */
  const late = (turnId: string, text: string, replyTo?: string, id?: string) => ({
    ...(id ? { id } : {}),
    sessionId: "concierge",
    turnId,
    role: "assistant",
    content: JSON.stringify([
      ...(replyTo ? [{ type: "reply_to", messageId: replyTo, author: "guardian", text: "…" }] : []),
      { type: "text", content: text },
    ]),
  });
  const texts = (c: ReturnType<typeof setup>) => c.said.map((s) => s.text);
  /** Rome speaks its question, and the guardian answers. */
  const answer = (c: ReturnType<typeof setup>, words: string) => {
    c.speak(c.said.length - 1);
    c.clock.advance(1000);
    c.conversation.heard(words, "");
    c.conversation.endpoint();
  };

  it("asks once both are quiet for 3 s, and sends the answer to the chat with what was asked", async () => {
    const c = setup({ nameOf: async (id) => (id === "start-1" ? "夏威夷酒店" : null) });
    c.conversation.arrived(late("system-1", "酒店查好了。一共三家。", "start-1", "msg-1"));
    await settled();
    c.clock.advance(OFFER_AFTER_QUIET_MS - 1);
    expect(c.said).toEqual([]);
    c.clock.advance(1);
    expect(texts(c)).toEqual(["「夏威夷酒店」有结果了，要听吗？"]);

    answer(c, "念一下，然后再查下明天天气");
    // Whatever the answer, it is the guardian's turn. The agent reads it.
    expect(c.sent).toEqual(["念一下，然后再查下明天天气"]);
    expect(c.notes[0]).toContain('"「夏威夷酒店」有结果了，要听吗？"');
    expect(c.notes[0]).toContain("message msg-1");
    expect(c.notes[0]).toContain("酒店查好了。一共三家。");
    await settled();
    c.turns[0]?.push({ type: "said", text: "三家酒店都在海边。明天晴。" });
    c.turns[0]?.end();
    await settled();
    expect(texts(c).slice(1)).toEqual(["三家酒店都在海边。", "明天晴。"]);
  });

  it("adds the note to the next turn only", async () => {
    const c = setup();
    c.conversation.arrived(late("system-1", "PR 合并了。"));
    await settled();
    c.clock.advance(OFFER_AFTER_QUIET_MS);
    answer(c, "先不用");
    c.turns[0]?.end();
    await settled();
    c.conversation.heard("明天几点开会", "");
    c.conversation.endpoint();
    expect(c.sent).toEqual(["先不用", "明天几点开会"]);
    expect(c.notes[0]).toContain("PR 合并了。");
    expect(c.notes[1]).toBeUndefined();
  });

  it("waits while the guardian speaks and while Rome answers", async () => {
    const c = setup();
    c.conversation.heard("帮我看看", "");
    c.conversation.arrived(late("system-1", "PR 合并了。"));
    c.clock.advance(5_000);
    expect(c.said).toEqual([]);
    c.conversation.endpoint();
    expect(c.notes).toEqual([undefined]);
    await settled();
    c.turns[0]?.push({ type: "said", text: "好的，我去看。" });
    c.turns[0]?.end();
    await settled();
    expect(texts(c)).toEqual(["好的，我去看。"]);
    c.speak(0, 2_000);
    // Rome speaks for 2 s, then both are quiet for 3 s.
    c.clock.advance(2_000 + OFFER_AFTER_QUIET_MS - 1);
    expect(c.said).toHaveLength(1);
    c.clock.advance(1);
    expect(texts(c)[1]).toBe("有新消息了，要听吗？");
  });

  it("asks about each task once a conversation", async () => {
    const c = setup();
    c.conversation.arrived(late("system-1", "测试都过了。", "start-1"));
    await settled();
    c.clock.advance(OFFER_AFTER_QUIET_MS);
    expect(texts(c)).toEqual(["有个任务有结果了，要听吗？"]);
    answer(c, "等会儿再说");
    c.turns[0]?.end();
    await settled();

    // The same task reports again: it was asked about already.
    c.conversation.arrived(late("system-2", "又跑了一遍，还是都过了。", "start-1"));
    await settled();
    c.clock.advance(60_000);
    expect(c.said).toHaveLength(1);
  });

  it("does not offer the messages of the guardian's own spoken turn", async () => {
    const c = setup();
    c.conversation.heard("查一下天气", "");
    c.conversation.endpoint();
    // The turn's message comes before its id is known.
    c.conversation.arrived(late("spoken-1", "明天晴。"));
    await settled();
    c.conversation.arrived(late("spoken-1", "温度二十度。"));
    c.turns[0]?.end();
    await settled();
    c.clock.advance(60_000);
    expect(c.said).toEqual([]);
  });

  it("tells only the newest report on a task, the one before being out of date", async () => {
    const c = setup();
    c.conversation.heard("说说别的", "");
    c.conversation.arrived(late("system-1", "还在跑，过了一半。", "start-1"));
    c.conversation.arrived(late("system-2", "跑完了，全部通过。", "start-1"));
    c.conversation.endpoint();
    await settled();
    c.turns[0]?.end();
    await settled();
    c.clock.advance(OFFER_AFTER_QUIET_MS);
    expect(texts(c)).toEqual(["有个任务有结果了，要听吗？"]);
    answer(c, "好，念吧");
    expect(c.notes[1]).toContain("跑完了，全部通过。");
    expect(c.notes[1]).not.toContain("过了一半");
  });

  it("offers nothing once the conversation has ended", async () => {
    const c = setup();
    c.conversation.arrived(late("system-1", "PR 合并了。"));
    await settled();
    c.conversation.close();
    c.clock.advance(60_000);
    c.conversation.arrived(late("system-2", "另一个结果。"));
    c.clock.advance(60_000);
    expect(c.said).toEqual([]);
  });
});
