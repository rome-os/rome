import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import { createRoutineInputSchema } from "../../../../rome_apps/system/src/actions/create-routine/index.js";

const skill = readFileSync(
  new URL("../../../../rome_apps/assistant/skills/routine-from-chat/SKILL.md", import.meta.url),
  "utf8",
);
const fallback = skill.split("## Surfaces without `propose_routine`")[1]?.split("\n## ")[0];

describe("routine-from-chat non-card guidance", () => {
  it("limits direct creation to an unavailable proposal tool and an explicit chat yes", () => {
    expect(fallback).toContain("only when `propose_routine` is not available");
    expect(fallback).toContain("yes in chat");
    expect(fallback).toContain("Without that yes, do not create or");
    expect(fallback).toContain("If the spec changes");
    expect(fallback).toContain("does not confirm the routine");
    expect(fallback).toContain("Do not bypass permissions");
  });

  it("documents plain-chat questions and valid direct-create arguments", () => {
    expect(skill).toContain("If `ask_question` is unavailable");
    expect(skill).toContain("wait for the guardian's answer");
    const example = fallback?.match(/```json\n([\s\S]*?)\n```/);
    expect(example).toBeTruthy();
    const args = JSON.parse(example![1]);
    expect(createRoutineInputSchema.safeParse(args).success).toBe(true);
    expect(args.trigger.tzMode).toBe("floating");
    expect(args.enabled).toBe(true);
  });
});
