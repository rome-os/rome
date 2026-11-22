import { describe, expect, it } from "@rstest/core";
import { type AddressingFacts, addressedRomeBy, addressing } from "./addressing.js";

const ME = "rome";
const OTHER_ROME = "rome-2";

function message(facts: {
  kind?: "direct" | "group";
  mentions?: readonly string[];
  repliesTo?: string;
  threadStartedBy?: string;
}): AddressingFacts {
  return {
    where: {
      kind: facts.kind ?? "group",
      ...(facts.threadStartedBy ? { thread: { startedBy: facts.threadStartedBy } } : {}),
    },
    ...(facts.mentions ? { mentions: facts.mentions } : {}),
    ...(facts.repliesTo ? { replyTo: { senderAccountId: facts.repliesTo } } : {}),
  };
}

describe("addressing", () => {
  const cases: Array<[string, Parameters<typeof message>[0], "rome" | "others" | "nobody"]> = [
    ["a direct message", { kind: "direct" }, "rome"],
    ["a direct message that mentions someone else", { kind: "direct", mentions: ["ann"] }, "rome"],
    ["a mention of me", { mentions: [ME] }, "rome"],
    ["a mention of me and someone else", { mentions: ["ann", ME] }, "rome"],
    ["a reply to me", { repliesTo: ME }, "rome"],
    // The one agreed change: a reply to Rome that also mentions someone else.
    ["a reply to me that mentions someone else", { repliesTo: ME, mentions: ["ann"] }, "rome"],
    ["a message in a thread I started", { threadStartedBy: ME }, "rome"],
    ["a mention of someone else", { mentions: ["ann"] }, "others"],
    ["a reply to someone else", { repliesTo: "ann" }, "others"],
    ["a mention of another of Rome's accounts", { mentions: [OTHER_ROME] }, "others"],
    ["a message in a thread someone else started", { threadStartedBy: "ann" }, "nobody"],
    ["a group message that mentions no one", {}, "nobody"],
    ["a group message whose mentions the connection cannot tell", {}, "nobody"],
    ["a mention list that is empty", { mentions: [] }, "nobody"],
  ];

  for (const [name, facts, expected] of cases) {
    it(`reads ${name} as ${expected}`, () => {
      expect(addressing(message(facts), ME)).toBe(expected);
    });
  }

  it("reads one message differently for each of Rome's accounts", () => {
    const said = message({ mentions: [OTHER_ROME] });
    expect(addressing(said, OTHER_ROME)).toBe("rome");
    expect(addressing(said, ME)).toBe("others");
  });

  it("names how a message addresses me, mention first", () => {
    expect(addressedRomeBy(message({ kind: "direct", mentions: [ME] }), ME)).toBe("direct");
    expect(addressedRomeBy(message({ mentions: [ME], repliesTo: ME }), ME)).toBe("mention");
    expect(addressedRomeBy(message({ repliesTo: ME, threadStartedBy: ME }), ME)).toBe("reply");
    expect(addressedRomeBy(message({ threadStartedBy: ME }), ME)).toBe("thread");
    expect(addressedRomeBy(message({ mentions: ["ann"] }), ME)).toBeNull();
  });
});
