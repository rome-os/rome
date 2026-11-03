// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import "@/i18n";
import { TraceJsonView } from "./TraceJsonView";

afterEach(cleanup);

describe("TraceJsonView", () => {
  it("sizes primitive array chips from the defined badge height token", () => {
    render(<TraceJsonView value={["alpha", "beta"]} />);

    const chip = screen.getByText("alpha").parentElement;
    expect(chip).not.toBeNull();
    expect(chip?.classList).toContain("h-[var(--badge-h)]");
    expect(chip?.className).not.toContain("--badge-py");
  });
});
