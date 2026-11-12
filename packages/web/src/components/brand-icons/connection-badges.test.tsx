// @rstest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import { ConnectionBrandBadge } from "./connection-badges";

afterEach(cleanup);

describe("ConnectionBrandBadge", () => {
  it("shows the tile through the Rome mark's face, not the page background", () => {
    const { container } = render(<ConnectionBrandBadge connection="webchat" />);
    expect(container.querySelector("svg mask")).not.toBeNull();
    expect(container.querySelector('[fill="var(--background)"]')).toBeNull();
  });
});
