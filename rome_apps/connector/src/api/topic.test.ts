import { describe, expect, it } from "@rstest/core";
import { buildTopic, PROVIDER_EVENT_PREFIX } from "./topic.js";

describe("buildTopic", () => {
  it("uses the canonical prefix and lowercases both inputs", () => {
    expect(buildTopic("Gmail", "NEW_MESSAGE")).toBe(`${PROVIDER_EVENT_PREFIX}gmail.new_message`);
  });
});
