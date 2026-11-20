// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";
import { isUpgradeUnderWay, useUpgradeUnderWay } from "./upgrade-under-way";

function Holder({ active }: { active: boolean }) {
  useUpgradeUnderWay(active);
  return null;
}

afterEach(() => {
  cleanup();
});

describe("upgrade under way", () => {
  it("holds while any part of the page is waiting on an upgrade", () => {
    expect(isUpgradeUnderWay()).toBe(false);
    const first = render(<Holder active />);
    const second = render(<Holder active />);
    expect(isUpgradeUnderWay()).toBe(true);

    first.rerender(<Holder active={false} />);
    expect(isUpgradeUnderWay()).toBe(true);
    second.unmount();
    expect(isUpgradeUnderWay()).toBe(false);
  });

  it("does not hold for a part that is not waiting", () => {
    render(<Holder active={false} />);
    expect(isUpgradeUnderWay()).toBe(false);
  });
});
