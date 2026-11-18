// @rstest-environment jsdom
import { describe, expect, it } from "@rstest/core";
import { withRomeWords } from "./WidgetUiCard";

describe("withRomeWords", () => {
  const translate = (key: string) => ({ "locationCard.share": "共享" })[key] ?? "";

  it("puts the guardian's words where the dashboard knows the name, and keeps the English otherwise", () => {
    expect(
      withRomeWords(
        { autoShare: true, romeStrings: { share: "Share", someday: "Someday" } },
        translate,
      ),
    ).toEqual({ autoShare: true, romeStrings: { share: "共享", someday: "Someday" } });
  });

  it("leaves a card with no Rome words as it is", () => {
    const data = { answers: [] };
    expect(withRomeWords(data, translate)).toBe(data);
    expect(withRomeWords(undefined, translate)).toBeUndefined();
  });
});
