import { describe, expect, it } from "@rstest/core";
import type { ConciergeFollowOptionDto } from "@rome/api-types/concierge";
import { renderOptions } from "./follow-options.js";

const options: ConciergeFollowOptionDto[] = [
  {
    key: "recipients",
    label: "Mail sent to",
    type: "enum",
    values: [
      { value: "to_and_cc", label: "Me, or with me in cc" },
      { value: "to", label: "Me directly" },
    ],
    default: "to_and_cc",
  },
  { key: "ignorePeople", label: "Ignore these people", type: "list", default: [] },
  { key: "includeBots", label: "Include bots", type: "boolean", default: false },
];

describe("renderOptions", () => {
  it("renders each option as the guardian's wish in words, from the catalog's labels", () => {
    expect(
      renderOptions(options, { recipients: "to", ignorePeople: ["dependabot[bot]", "renovate"] }),
    ).toEqual([
      "Mail sent to: Me directly",
      "Ignore these people: dependabot[bot], renovate",
      "Include bots: no",
    ]);
  });

  it("uses the default for a missing or unfitting value, and leaves an empty list out", () => {
    expect(renderOptions(options, { recipients: "bcc", includeBots: true })).toEqual([
      "Mail sent to: Me, or with me in cc",
      "Include bots: yes",
    ]);
  });
});
