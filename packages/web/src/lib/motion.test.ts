import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { EASE_IN_OUT_TRAVEL, EASE_OUT_EXPO, ROLL, TRAVEL } from "@/lib/motion";

const stylesheet = readFileSync(join(import.meta.dirname, "../../../ui/src/styles.css"), "utf8");

const declared = (token: string) => stylesheet.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];

describe("motion constants", () => {
  it("match the tokens the stylesheet declares", () => {
    expect(declared("--rome-ease-out-expo")).toBe(`cubic-bezier(${EASE_OUT_EXPO.join(", ")})`);
    expect(declared("--rome-ease-in-out-travel")).toBe(
      `cubic-bezier(${EASE_IN_OUT_TRAVEL.join(", ")})`,
    );
    expect(declared("--rome-duration-300")).toBe(`${TRAVEL.duration * 1000}ms`);
    expect(declared("--rome-duration-200")).toBe(`${ROLL.duration * 1000}ms`);
  });
});
