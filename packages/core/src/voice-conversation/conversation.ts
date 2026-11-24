// One voice conversation: what Rome does with what it hears, and what it says
// back. Each finished turn of the guardian's goes to the chat. The reply is
// read as it streams, cut into sentences and spoken. Speaking over the reply
// stops it at once. While the agent works with nothing to say for 2 s, Rome
// says once that it is looking. The socket, listening and the chat are the
// caller's: this file holds no I/O of its own, so tests drive it by hand.

import type {
  VoiceConversationServerMessage,
  VoiceConversationState,
  VoiceConversationStopReason,
} from "@rome/api-types/voice-conversation";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import type { SpeakerListener, SpeakerSession } from "../voice-output/speaker.js";
import { enoughWords, isEcho, isLateEcho } from "./barge-in.js";
import { createSentenceSplitter, type SentenceSplitter } from "./sentences.js";
import {
  createSpeakableFilter,
  plainSentence,
  type ReplyLanguage,
  type SpeakableFilter,
} from "./speakable.js";

const log = createLogger("voice-conversation");

/**
 * Opens the model's prompt for a turn the guardian spoke, for that turn only:
 * the reply is read aloud, as a secretary answers on the phone. It leads with
 * the conclusion in a sentence or two, without echoing the guardian or asking
 * back, names what the guardian must decide, and says what went wrong. Details
 * stay in the chat, and nothing that needs its original text is settled by
 * voice. The conversation does not read code or tables out.
 */
export const SPOKEN_TURN_NOTE = [
  "<voice_context>",
  "The guardian said this aloud on a voice call and hears your reply read aloud. Answer as a secretary on the phone, in the language they spoke:",
  "- Lead with the conclusion, in one or two short spoken sentences.",
  "- Do not repeat back what they said, and do not ask follow-up questions.",
  "- Use no headings, lists or other formatting.",
  "- If they must decide something, name it with at most two options.",
  "- If something went wrong, say so plainly.",
  "- Leave details, code and tables to the chat as usual. They are not read aloud, so say only that the details are in the chat.",
  "- Anything that needs its original text to decide, such as a pull request's text before it opens, a merge, an email, spending or an approval, is only mentioned on the call: say it is waiting in the chat, and do not take a spoken answer as the decision. A decision that needs no original text and sends nothing out may be made by voice.",
  "</voice_context>",
].join("\n");

/** How long the agent may work with nothing said before Rome says it is looking. */
export const LOOKING_AFTER_MS = 2_000;
const LOOKING = { zh: "我查一下。", en: "Let me check." };
const FAILED = {
  zh: "出了点问题，详细内容在聊天里。",
  en: "Something went wrong. The details are in the chat.",
};
// Recognition lags the audio, and the client still plays what it holds, so
// Rome's own last words may be heard this long after they were sent.
const ECHO_TAIL_MS = 2_000;

/**
 * What a reply is made of: the turn's events, or, for an agent whose text is
 * private, the messages it delivers. `said` is a message's text. `shown` is
 * something in the chat that is not said, such as a card.
 */
export type ReplyEvent = StreamAgentEvent | { type: "said"; text: string } | { type: "shown" };

/** A turn of the chat's agent, as far as the conversation reads it. */
export interface ReplyTurn {
  events(): AsyncIterable<ReplyEvent>;
}

export interface ConversationDeps {
  /**
   * Sends the guardian's turn to the chat, and resolves with the turn that
   * answers it. Rejects when the chat refuses it. `signal` aborts once the
   * conversation no longer waits for that turn, so the send lets go of what it holds.
   */
  send(text: string, signal: AbortSignal): Promise<ReplyTurn>;
  /** A text frame to the client. */
  message(message: VoiceConversationServerMessage): void;
  /** Reply audio to the client, in the order to play it. */
  audio(pcm: Uint8Array): void;
  /** Ends the conversation. */
  fail(reason: VoiceConversationStopReason): void;
  /** Runs `fn` after `ms`, and returns the cancel. */
  schedule?: (ms: number, fn: () => void) => () => void;
  now?: () => number;
}

export interface Conversation {
  /** The listener to open the speaker with. */
  readonly speakerListener: SpeakerListener;
  /** Starts speaking on the opened session. */
  attach(speaker: SpeakerSession): void;
  /** What the transcriber heard of the guardian's turn: new settled text, and the whole pending tail. */
  heard(settled: string, pending: string): void;
  /** The guardian finished a turn. */
  endpoint(): void;
  /** Stops speaking and reading. Nothing is sent after this. */
  close(): void;
}

interface Reply {
  language: ReplyLanguage;
  filter: SpeakableFilter;
  splitter: SentenceSplitter;
  /** Sentences said, to name the next one. */
  said: number;
  ended: boolean;
  /** Rome said it is looking, or something was said already. */
  quietOver: boolean;
  /** Aborts once the conversation moves on from this reply. */
  left: AbortController;
}

/** A sentence said, until all its audio has gone to the client. */
interface Queued {
  id: string;
  text: string;
  /** Audio that came before the sentence's turn to play. */
  waiting: Uint8Array[];
  started: boolean;
  done: boolean;
}

const realSchedule = (ms: number, fn: () => void) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const languageOf = (text: string): ReplyLanguage => (/\p{Script=Han}/u.test(text) ? "zh" : "en");

export function createConversation(deps: ConversationDeps): Conversation {
  const schedule = deps.schedule ?? realSchedule;
  const now = deps.now ?? Date.now;
  let speaker: SpeakerSession | null = null;
  let closed = false;
  let state: VoiceConversationState = "listening";

  // The guardian's turn so far.
  let settled = "";
  let pending = "";
  // The turn began while Rome's words could still come back, and did not
  // count as speaking over them. A turn begun after that is the guardian's.
  let maybeEcho = false;
  let begun = false;
  let begunAt = 0;
  // For a turn begun once Rome's audio had played, the sentences that could
  // come back then: only a whole run of the last ones is an echo.
  let lateEcho: string[] | null = null;

  let reply: Reply | null = null;
  let replies = 0;
  const queue: Queued[] = [];
  // When the audio sent so far ends, as the client plays it.
  let playsUntil = 0;
  // Until when what is heard may be Rome's own voice.
  let echoUntil = 0;
  // Rome's sentences whose audio may still come back. Those of the reply now
  // playing last as long as `echoUntil`. Those of a reply stopped keep their
  // own end, however soon the next reply plays.
  let spoken: { text: string; until: number | null }[] = [];
  const echoAt = (at: number) =>
    spoken.filter((s) => at < (s.until ?? echoUntil)).map((s) => s.text);
  let stopPlayed = () => {};
  let stopLooking: (() => void) | null = null;

  const setState = (next: VoiceConversationState) => {
    if (next === state || closed) return;
    state = next;
    deps.message({ type: "state", state });
  };

  // The state follows from what plays and what the agent still does.
  const update = () => {
    if (closed) return;
    const playing = now() < playsUntil;
    const working = reply !== null && (!reply.ended || queue.length > 0);
    setState(playing ? "speaking" : working ? "thinking" : "listening");
    const waitingFor = reply;
    const quiet =
      waitingFor !== null &&
      !waitingFor.ended &&
      !waitingFor.quietOver &&
      !playing &&
      queue.length === 0;
    if (waitingFor && quiet && !stopLooking) {
      stopLooking = schedule(LOOKING_AFTER_MS, () => {
        stopLooking = null;
        if (reply !== waitingFor || closed) return;
        waitingFor.quietOver = true;
        say(waitingFor, LOOKING[waitingFor.language]);
      });
    } else if (!quiet && stopLooking) {
      stopLooking();
      stopLooking = null;
    }
  };

  const play = (pcm: Uint8Array) => {
    if (!speaker || pcm.byteLength === 0) return;
    deps.audio(pcm);
    // PCM s16le mono: two bytes a sample.
    const ms = (pcm.byteLength / 2 / speaker.format.sampleRate) * 1000;
    playsUntil = Math.max(playsUntil, now()) + ms;
    echoUntil = playsUntil + ECHO_TAIL_MS;
    // Rome plays again during the turn, so any of its words may come back.
    if (begun) lateEcho = null;
    stopPlayed();
    stopPlayed = schedule(Math.ceil(playsUntil - now()), update);
    update();
  };

  // Sends the head sentence's audio, and moves on past each finished one.
  const pump = () => {
    while (queue.length > 0) {
      const head = queue[0] as Queued;
      if (!head.started) {
        head.started = true;
        deps.message({ type: "caption", text: head.text });
        // Rome's words are kept while any of its audio may still be heard, however far
        // the speech runs ahead of playback, and forgotten after.
        spoken = spoken.filter((s) => now() < (s.until ?? echoUntil));
        spoken.push({ text: head.text, until: null });
      }
      for (const pcm of head.waiting.splice(0)) play(pcm);
      if (!head.done) break;
      queue.shift();
    }
    update();
  };

  const say = (to: Reply, text: string) => {
    if (!speaker || reply !== to) return;
    to.quietOver = true;
    const id = `${replies}-${to.said++}`;
    queue.push({ id, text, waiting: [], started: false, done: false });
    speaker.say(id, text);
    pump();
  };

  const speakAll = (to: Reply, sentences: string[]) => {
    for (const sentence of sentences) {
      const plain = plainSentence(sentence);
      if (plain) say(to, plain);
    }
  };

  const feed = (to: Reply, markdown: string) =>
    speakAll(to, to.splitter.push(to.filter.push(markdown)));

  const finish = (to: Reply) => {
    if (to.ended) return;
    speakAll(to, [...to.splitter.push(to.filter.end()), ...to.splitter.end()]);
    to.ended = true;
    update();
  };

  // Stops the reply: what is said and queued, and what the client still plays.
  const drop = () => {
    if (reply || queue.length > 0) speaker?.stop();
    reply?.left.abort();
    reply = null;
    const unplayed = now() < playsUntil || queue.some((q) => q.started);
    queue.length = 0;
    playsUntil = 0;
    // The client drops the audio not played, so only the recognition tail can come back.
    echoUntil = Math.min(echoUntil, now() + ECHO_TAIL_MS);
    for (const s of spoken) s.until ??= echoUntil;
    stopPlayed();
    if (unplayed) deps.message({ type: "clear" });
    update();
  };

  const read = async (to: Reply, turn: ReplyTurn) => {
    // Text from another agent, such as a subagent the turn called, is not the reply.
    let agent: string | undefined;
    // Blocks whose text came in deltas: their whole block repeats it.
    const streamed = new Set<string>();
    let streamedLoose = false;
    let saidAny = false;
    for await (const event of turn.events()) {
      if (reply !== to) return;
      if (event.type === "said") {
        saidAny ||= event.text.trim() !== "";
        // A message ends its sentence.
        feed(to, `${event.text}\n`);
        continue;
      }
      if (event.type === "shown") {
        speakAll(to, to.splitter.push(to.filter.point()));
        continue;
      }
      if (event.type === "turn_start") agent ??= event.agent;
      const own = !event.agent || !agent || event.agent === agent;
      if (event.type === "text_delta" && own) {
        if (event.blockId) streamed.add(event.blockId);
        else streamedLoose = true;
        saidAny ||= event.content.trim() !== "";
        feed(to, event.content);
      } else if (event.type === "text" && own) {
        const repeated = event.blockId ? streamed.has(event.blockId) : streamedLoose;
        streamedLoose = false;
        if (!repeated) {
          saidAny ||= event.content.trim() !== "";
          feed(to, event.content);
        }
        // A block ends its sentence.
        feed(to, "\n");
      } else if (event.type === "tool_use" && own) {
        // What came before a tool call is said before the call, not after it.
        feed(to, "\n");
      } else if (event.type === "error" && own && !saidAny) {
        say(to, FAILED[to.language]);
        saidAny = true;
      }
    }
    if (reply === to) finish(to);
  };

  const conversation: Conversation = {
    speakerListener: {
      onAudio(frame) {
        const queued = queue.find((q) => q.id === frame.sentenceId);
        if (!queued) return;
        if (queued === queue[0]) play(frame.pcm);
        else queued.waiting.push(frame.pcm);
      },
      onSentenceEnd(sentenceId) {
        const queued = queue.find((q) => q.id === sentenceId);
        if (!queued) return;
        queued.done = true;
        pump();
      },
      onSentenceError(sentenceId, error) {
        log.warn("sentence not spoken", { kind: error.kind });
        conversation.speakerListener.onSentenceEnd(sentenceId);
      },
      onClosed(error) {
        if (closed) return;
        log.warn("speaking stopped", { kind: error.kind });
        deps.fail("speaking-failed");
      },
    },

    attach(session) {
      speaker = session;
    },

    heard(newSettled, newPending) {
      if (closed) return;
      settled += newSettled;
      pending = newPending;
      deps.message({ type: "heard", settled, pending });
      const words = `${settled}${pending}`;
      if (!begun && words.trim()) {
        begun = true;
        begunAt = now();
        // Recognition runs behind the audio, so Rome's words may come back after it played.
        const playing = begunAt < playsUntil;
        const back = echoAt(begunAt);
        maybeEcho = playing || back.length > 0;
        lateEcho = playing ? null : back;
      }
      if (state === "speaking" && enoughWords(words) && !isEcho(words, echoAt(begunAt).join(" "))) {
        log.info("guardian spoke over the reply");
        maybeEcho = false;
        drop();
      }
    },

    endpoint() {
      if (closed) return;
      const text = `${settled}${pending}`.trim();
      const suspect = maybeEcho;
      const late = lateEcho;
      settled = "";
      pending = "";
      maybeEcho = false;
      lateEcho = null;
      begun = false;
      // Rome's own words coming back are not a turn. A short answer is always
      // the guardian's: "No" or "香蕉" is likely to be part of what Rome just said.
      // Heard after the audio played, only Rome's whole last sentences are its
      // own: "下午的航班" picks from them.
      const romes =
        suspect &&
        enoughWords(text) &&
        (late ? isLateEcho(text, late) : isEcho(text, echoAt(begunAt).join(" ")));
      if (!text || romes) {
        if (text) deps.message({ type: "heard", settled: "", pending: "" });
        return;
      }
      drop();
      replies++;
      const to: Reply = {
        language: languageOf(text),
        filter: createSpeakableFilter(languageOf(text)),
        splitter: createSentenceSplitter(),
        said: 0,
        ended: false,
        quietOver: false,
        left: new AbortController(),
      };
      reply = to;
      deps.message({ type: "turn", text });
      update();
      deps.send(text, to.left.signal).then(
        (turn) =>
          read(to, turn).catch((err: unknown) => {
            // The reply still shows in the chat. Rome says what it has.
            log.warn("voice reply not read", {
              error: err instanceof Error ? err.message : String(err),
            });
            if (reply === to) finish(to);
          }),
        (err: unknown) => {
          if (reply !== to || closed) return;
          log.warn("voice turn not sent", {
            error: err instanceof Error ? err.message : String(err),
          });
          deps.fail("chat-refused");
        },
      );
    },

    close() {
      if (closed) return;
      closed = true;
      reply?.left.abort();
      reply = null;
      queue.length = 0;
      stopPlayed();
      stopLooking?.();
      speaker?.close();
    },
  };
  return conversation;
}
