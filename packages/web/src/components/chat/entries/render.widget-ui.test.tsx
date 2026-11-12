// @rstest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "@rstest/core";
import "@/i18n";
import { parseEntries } from "./parse-entries";
import { renderFlatEntries } from "./render";

afterEach(cleanup);

describe("a widget described as data", () => {
  it("is kept by the parser and shows its line", () => {
    const blocks = parseEntries(
      JSON.stringify([
        {
          type: "widget",
          toolUseId: "w",
          appId: "meals",
          ui: { components: [{ id: "root", component: "Text", text: "Hi" }] },
          text: "Today's meals.",
        },
      ]),
    );
    expect(blocks).toHaveLength(1);
    render(<>{renderFlatEntries(blocks, { sessionId: "s1" })}</>);
    expect(screen.getByText("Today's meals.")).toBeTruthy();
  });
});
