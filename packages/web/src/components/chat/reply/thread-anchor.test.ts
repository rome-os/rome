import { describe, expect, it } from "@rstest/core";
import { playLanding } from "./thread-anchor";

describe("playLanding", () => {
  // Records the message's transition each time its tint mark changes.
  const watched = () => {
    const anchor = { style: { transition: "" }, offsetWidth: 0 } as unknown as HTMLElement;
    const marks = new Set<string>();
    const steps: string[] = [];
    Object.assign(anchor, {
      hasAttribute: (name: string) => marks.has(name),
      setAttribute: (name: string) => {
        marks.add(name);
        steps.push(`on ${anchor.style.transition || "-"}`);
      },
      removeAttribute: (name: string) => {
        marks.delete(name);
        steps.push(`off ${anchor.style.transition || "-"}`);
      },
    });
    return { anchor, steps };
  };

  it("tints a message with no tint", () => {
    const { anchor, steps } = watched();
    playLanding(anchor);
    expect(steps).toEqual(["on -"]);
  });

  it("drops a tint still on at once, so it plays again from none", () => {
    const { anchor, steps } = watched();
    playLanding(anchor);
    playLanding(anchor);
    expect(steps).toEqual(["on -", "off none", "on -"]);
    expect(anchor.style.transition).toBe("");
  });
});
