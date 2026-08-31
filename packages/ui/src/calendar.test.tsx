import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";

import { Calendar } from "./calendar.js";

afterEach(cleanup);

describe("Calendar", () => {
  it("renders the Rome-adapted radius and typography roles", () => {
    const month = new Date(2026, 7, 1);
    const { container } = render(<Calendar defaultMonth={month} />);

    expect(container.querySelector('[data-slot="calendar"]')).not.toBeNull();
    expect(container.querySelector(".rdp-weekday")?.className).toContain("text-aux");

    const classes = Array.from(container.querySelectorAll("*"))
      .flatMap((element) => (element.getAttribute("class") ?? "").split(/\s+/))
      .filter(Boolean);

    expect(classes).toContain("rounded-8");
    expect(classes).not.toContain("rounded-md");
    expect(classes).not.toContain("text-sm");
  });
});
