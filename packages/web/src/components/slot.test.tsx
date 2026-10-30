// @rstest-environment jsdom
import { Activity } from "react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render, screen } from "@testing-library/react";
import { SlotContent, SlotOutlet, SlotProvider, useSlotOutlet } from "./slot";

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

// The kept Concierge page fills the mobile header and the title bar while
// another page may fill them too, so a hidden page's filler hides its content.
describe("SlotContent in an Activity", () => {
  const page = (mode: "visible" | "hidden") => (
    <SlotProvider>
      <SlotOutlet name="bar" className="bar" fallback={<i>fallback</i>} />
      <Activity mode={mode}>
        <SlotContent name="bar" hideWithPage>
          <b>page bar</b>
        </SlotContent>
      </Activity>
    </SlotProvider>
  );
  // What the browser shows is what the filler's own wrapper says.
  const wrapperDisplay = () => screen.getByText("page bar").parentElement?.style.display;

  it("hides what it put in the outlet while the page is hidden, and shows it again", async () => {
    const view = render(page("visible"));
    const bar = await screen.findByText("page bar");
    expect(wrapperDisplay()).toBe("contents");

    view.rerender(page("hidden"));
    expect(wrapperDisplay()).toBe("none");
    expect(await screen.findByText("fallback")).toBeTruthy();

    view.rerender(page("visible"));
    expect(wrapperDisplay()).toBe("contents");
    expect(screen.getByText("page bar")).toBe(bar);
  });

  it("puts nothing around content that is not asked to hide", async () => {
    render(
      <SlotProvider>
        <SlotOutlet name="bar" className="bar" />
        <SlotContent name="bar">
          <b>plain</b>
        </SlotContent>
      </SlotProvider>,
    );
    expect((await screen.findByText("plain")).parentElement?.className).toBe("bar");
  });
});
