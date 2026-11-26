import { describe, expect, it } from "@rstest/core";
import { hitsIn, judge } from "./inside-checks.js";

describe("checks inside Rome", () => {
  it("finds a line that decides by the guardian, personal data or the audience", () => {
    const text = [
      'if (actor.kind === "guardian") return;',
      'if (actor.via !== "cookie") return;',
      "if (isPersonalDataAction(name)) return;",
      'if (turn.audience !== "private") return;',
      "if (capability.personal) return;",
      'const label = actor.kind === "visitor" ? "Visitor" : name;',
    ].join("\n");
    expect(hitsIn(text)).toEqual([1, 2, 3, 4, 5]);
  });

  it("leaves out comments, and words that only look alike", () => {
    const text = [
      "// isGuardian: the audience of a private chat",
      'const url = "https://example.test"; // turnAudience',
      "/* PERSONAL_DATA_PRIVATE_ONLY */ const sources = PERSONAL_DATA_SOURCES;",
      'if (status === "audience_mismatch") return;',
    ].join("\n");
    expect(hitsIn(text)).toEqual([]);
  });

  it("fails a new line, and a count that dropped without its baseline", () => {
    const file = "packages/core/src/x.ts";
    expect(judge(new Map([[file, 2]]), { [file]: 2 })).toEqual([]);
    expect(judge(new Map([[file, 3]]), { [file]: 2 })).toHaveLength(1);
    expect(judge(new Map([[file, 1]]), { [file]: 2 })).toHaveLength(1);
    expect(judge(new Map(), { [file]: 2 })).toHaveLength(1);
    expect(judge(new Map([[file, 1]]), {})).toHaveLength(1);
  });

  it("allows Access, and the lines listed as allowed", () => {
    expect(judge(new Map([["packages/core/src/access/team.ts", 9]]), {})).toEqual([]);
    expect(judge(new Map([["packages/core/src/api/routes/vault.ts", 3]]), {})).toEqual([]);
    expect(judge(new Map([["packages/core/src/api/routes/vault.ts", 4]]), {})).toHaveLength(1);
    expect(judge(new Map([["packages/core/src/api/routes/vault.ts", 2]]), {})).toHaveLength(1);
  });
});
