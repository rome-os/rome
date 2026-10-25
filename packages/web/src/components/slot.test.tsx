// @rstest-environment jsdom
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { SlotOutlet, SlotProvider, useSlotOutlet } from "./slot";

function Probe() {
  return <output data-testid="has">{String(useSlotOutlet("bar"))}</output>;
}

afterEach(cleanup);

describe("useSlotOutlet", () => {
  it("is false without a provider, so a page rendered alone keeps its own header", () => {
    render(<Probe />);
    expect(screen.getByTestId("has").textContent).toBe("false");
  });

  it("is false when no outlet of that name is on the page", () => {
    render(
      <SlotProvider>
        <SlotOutlet name="other" />
        <Probe />
      </SlotProvider>,
    );
    expect(screen.getByTestId("has").textContent).toBe("false");
  });

  it("is true once the outlet is on the page", () => {
    render(
      <SlotProvider>
        <SlotOutlet name="bar" />
        <Probe />
      </SlotProvider>,
    );
    expect(screen.getByTestId("has").textContent).toBe("true");
  });
});
