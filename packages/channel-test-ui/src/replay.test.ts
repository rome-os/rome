import { describe, expect, it } from "@rstest/core";
import {
  beatAt,
  DEFAULT_REPLAY_SETTINGS,
  normalizeReplaySettings,
  planReplay,
  type ReplaySettings,
  replayAt,
} from "./replay.js";
import type { TraceChange } from "./trace.js";

const change = (id: string, from: "rome" | "user", text: string, edits = 0): TraceChange => ({
  at: 0,
  message: { id, conversation: "c", from, text, edits },
});

// Round numbers, so a duration is easy to check by hand: 10 characters a second
// is 100 ms a character.
const SETTINGS: ReplaySettings = {
  messageDelayMs: 100,
  editDelayMs: 50,
  typewriter: true,
  charsPerSecond: 10,
  maxTypingMs: 5_000,
  typeUserMessages: false,
};

// The same, with a cap of one second a message.
const CAPPED: ReplaySettings = { ...SETTINGS, maxTypingMs: 1_000 };

// The user writes, then Rome answers and streams the answer in two edits.
const STREAMED: TraceChange[] = [
  change("1", "user", "hello"),
  change("2", "rome", "hi"),
  change("2", "rome", "hi there", 1),
  change("2", "rome", "hi there, friend", 2),
];

describe("planReplay", () => {
  it("starts the first change at 0 and spaces the rest by the delay for their kind", () => {
    const plan = planReplay(STREAMED, SETTINGS);

    expect(plan.beats.map((beat) => [beat.kind, beat.start, beat.end])).toEqual([
      ["create", 0, 0], // the user's message is not typed
      ["create", 100, 300], // 2 characters
      ["edit", 350, 950], // 6 new characters after the kept "hi"
      ["edit", 1000, 1800], // 8 new characters after the kept "hi there"
    ]);
    expect(plan.duration).toBe(1800);
  });

  it("keeps the text an edit shares with the one before, so a streamed reply grows", () => {
    const [, , second, third] = planReplay(STREAMED, SETTINGS).beats;

    expect([second?.keep, third?.keep]).toEqual([2, 8]);
  });

  it("types an edit from where the text first differs, not from the end", () => {
    const plan = planReplay(
      [change("1", "rome", "hello world"), change("1", "rome", "hello there", 1)],
      SETTINGS,
    );

    expect(plan.beats[1]?.keep).toBe(6);
  });

  it("caps how long one message takes, however long it is", () => {
    const plan = planReplay([change("1", "rome", "a".repeat(5_000))], CAPPED);

    expect(plan.duration).toBe(1_000);
  });

  it("caps a message across all its edits, so a long streamed reply is not slow", () => {
    const stream = [
      change("1", "rome", "a".repeat(500)),
      change("1", "rome", `${"a".repeat(500)}${"b".repeat(500)}`, 1),
      change("1", "rome", `${"a".repeat(500)}${"b".repeat(500)}${"c".repeat(500)}`, 2),
    ];

    const plan = planReplay(stream, CAPPED);

    // 1500 characters typed in 1000 ms, and two edit delays of 50 ms.
    expect(plan.duration).toBeCloseTo(1_100, 5);
  });

  it("keeps the set speed for a message that fits under the cap", () => {
    const plan = planReplay([change("1", "rome", "a".repeat(5))], SETTINGS);

    expect(plan.duration).toBe(500);
  });

  it("types nothing when the cap is zero", () => {
    const plan = planReplay([change("1", "rome", "hello")], { ...SETTINGS, maxTypingMs: 0 });

    expect(plan.duration).toBe(0);
  });

  it("types the user's messages only when asked", () => {
    const user = [change("1", "user", "hello")];

    expect(planReplay(user, SETTINGS).duration).toBe(0);
    expect(planReplay(user, { ...SETTINGS, typeUserMessages: true }).duration).toBe(500);
  });

  it("shows each message whole, after its delay, with the typewriter off", () => {
    const plan = planReplay(STREAMED, { ...SETTINGS, typewriter: false });

    expect(plan.beats.map((beat) => [beat.start, beat.end])).toEqual([
      [0, 0],
      [100, 100],
      [150, 150],
      [200, 200],
    ]);
  });

  it("plans nothing for a conversation without changes", () => {
    expect(planReplay([], SETTINGS)).toEqual({ beats: [], duration: 0 });
  });
});

describe("replayAt", () => {
  const plan = planReplay(STREAMED, SETTINGS);
  const at = (time: number) =>
    replayAt(plan, time).map(({ message, typing }) => [message.id, message.text, typing]);

  it("shows nothing before the first change", () => {
    expect(replayAt(planReplay([change("1", "rome", "hi")], SETTINGS), -1)).toEqual([]);
  });

  it("shows a message once its change starts, with the text typed so far", () => {
    expect(at(0)).toEqual([["1", "hello", false]]);
    expect(at(200)).toEqual([
      ["1", "hello", false],
      ["2", "h", true],
    ]);
  });

  it("types an edit after the text the message already showed", () => {
    expect(at(650)).toEqual([
      ["1", "hello", false],
      ["2", "hi th", true],
    ]);
  });

  it("shows the finished text between two changes", () => {
    expect(at(980)).toEqual([
      ["1", "hello", false],
      ["2", "hi there", false],
    ]);
  });

  it("shows the final conversation at the end, in the order the messages first appeared", () => {
    expect(at(plan.duration)).toEqual([
      ["1", "hello", false],
      ["2", "hi there, friend", false],
    ]);
  });

  it("carries the edit count of the change being shown", () => {
    const edits = replayAt(plan, 650).map(({ message }) => message.edits);

    expect(edits).toEqual([0, 1]);
  });

  it("drops the text an edit removes at once, then types what follows the shared start", () => {
    const shortened = planReplay(
      [change("1", "rome", "hello world"), change("1", "rome", "hello", 1)],
      SETTINGS,
    );

    expect(replayAt(shortened, shortened.duration)[0]?.message.text).toBe("hello");
  });
});

describe("beatAt", () => {
  const plan = planReplay(STREAMED, SETTINGS);

  it("finds the latest change that has started", () => {
    expect(beatAt(plan, 0)?.message.id).toBe("1");
    expect(beatAt(plan, 400)?.message.text).toBe("hi there");
  });

  it("finds none before the first change", () => {
    expect(beatAt(plan, -1)).toBeUndefined();
  });
});

describe("normalizeReplaySettings", () => {
  it("takes the defaults for anything missing or of the wrong type", () => {
    expect(normalizeReplaySettings(undefined)).toEqual(DEFAULT_REPLAY_SETTINGS);
    expect(normalizeReplaySettings({ messageDelayMs: "slow", typewriter: 1 })).toEqual(
      DEFAULT_REPLAY_SETTINGS,
    );
    expect(normalizeReplaySettings({ editDelayMs: Number.NaN })).toEqual(DEFAULT_REPLAY_SETTINGS);
  });

  it("keeps valid values and moves an out-of-range number to the nearest end", () => {
    expect(
      normalizeReplaySettings({
        messageDelayMs: 1_200,
        editDelayMs: -5,
        charsPerSecond: 0,
        maxTypingMs: 999_999,
        typewriter: false,
        typeUserMessages: true,
      }),
    ).toEqual({
      messageDelayMs: 1_200,
      editDelayMs: 0,
      charsPerSecond: 1,
      maxTypingMs: 30_000,
      typewriter: false,
      typeUserMessages: true,
    });
  });

  it("takes the defaults it is given for what is missing", () => {
    const quiet = { ...DEFAULT_REPLAY_SETTINGS, typewriter: false };

    expect(normalizeReplaySettings({}, quiet).typewriter).toBe(false);
  });
});
