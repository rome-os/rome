import { describe, expect, it } from "@rstest/core";
import { hitsIn, judge } from "./inside-checks.js";

const lines = (text: string) => hitsIn(text).map(({ line }) => line);

describe("checks inside Rome", () => {
  it("finds a line that decides by the guardian, personal data or the audience", () => {
    const text = [
      'if (actor.kind === "guardian") return;',
      'if (actor.via !== "cookie") return;',
      'if (actor.kind === "visitor") return;',
      'switch (actor.kind) { case "guardian": break; }',
      "if (isPersonalDataAction(name)) return;",
      'if (turn.audience !== "private") return;',
      "if (capability.personal) return;",
      'const label = actor.name ?? "Rome";',
    ].join("\n");
    expect(lines(text)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("leaves out comments, imports, types, and words that only look alike", () => {
    const text = [
      "// isGuardian: the audience of a private chat",
      'const url = "https://example.test"; // turnAudience',
      "/* PERSONAL_DATA_PRIVATE_ONLY */ const sources = PERSONAL_DATA_SOURCES;",
      'if (status === "audience_mismatch") return;',
      'import { placeAudience } from "./place-audience.js";',
      'type Who = { kind: "guardian" } | { audience: Audience };',
      "function f(turn: TurnAudience): void {}",
    ].join("\n");
    expect(lines(text)).toEqual([]);
  });

  it("fails a new line, and a count that dropped without its baseline", () => {
    const file = "packages/core/src/x.ts";
    const hits = (...texts: string[]) => new Map([[file, texts]]);
    expect(judge(hits("a", "b"), { [file]: 2 }, {})).toEqual([]);
    expect(judge(hits("a", "b", "c"), { [file]: 2 }, {})).toHaveLength(1);
    expect(judge(hits("a"), { [file]: 2 }, {})).toHaveLength(1);
    expect(judge(new Map(), { [file]: 2 }, {})).toHaveLength(1);
    expect(judge(hits("a"), {}, {})).toHaveLength(1);
  });

  it("allows Access, and each line listed as allowed, by its text", () => {
    const file = "packages/core/src/x.ts";
    const allowed = { [file]: { why: "labels", lines: ["label"] } };
    expect(judge(new Map([["packages/core/src/access/team.ts", ["a"]]]), {}, {})).toEqual([]);
    expect(judge(new Map([[file, ["label"]]]), {}, allowed)).toEqual([]);
    expect(judge(new Map([[file, ["label", "check"]]]), {}, allowed)).toHaveLength(1);
    // A check in place of an allowed line is new, and the allowed line is gone.
    expect(judge(new Map([[file, ["check"]]]), {}, allowed)).toHaveLength(2);
    expect(judge(new Map(), {}, allowed)).toHaveLength(1);
  });
});
