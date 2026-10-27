import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import { createRoutineInputSchema } from "../../../../rome_apps/system/src/actions/create-routine/index.js";

const skill = readFileSync(
  new URL("../../../../rome_apps/assistant/skills/routine-from-chat/SKILL.md", import.meta.url),
  "utf8",
);
const fallback = skill.split(/^## /m).find((section) => /^[^\n]*`propose_routine`/.test(section));
const plainFallback = fallback?.replace(/[*`]/g, "").replace(/\s+/g, " ");

describe("routine-from-chat non-card guidance", () => {
  it("documents guardian confirmation and a subagent handoff", () => {
    expect(fallback).toBeDefined();
    expect(plainFallback).toMatch(/explicit yes/i);
    expect(skill).toMatch(/^## .*delegat/im);
  });

  it("shows schema-valid direct-create arguments with a deduplication key", () => {
    const example = fallback?.match(/```json\n([\s\S]*?)\n```/);
    expect(example).toBeTruthy();
    const args = JSON.parse(example![1]);
    expect(createRoutineInputSchema.safeParse(args).success).toBe(true);
    expect(args.trigger.tzMode).toBe("floating");
    expect(args.enabled).toBe(true);
    expect(typeof args.key).toBe("string");
    expect(args.key.length).toBeGreaterThan(0);
  });
});
