import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const policy = (
  parseYaml(readFileSync(resolve(here, "../../../agents/envoy.yaml"), "utf8")) as {
    systemPromptPrefix: string;
  }
).systemPromptPrefix.replace(/\s+/g, " ");

describe("the envoy's policy", () => {
  it("lets what a participant said be repeated in the same chat, and holds it from every other chat", () => {
    expect(policy).toContain(
      "What a participant said in a chat may be repeated in that same chat to the people in it.",
    );
    expect(policy).toContain(
      "It is never repeated in another chat: what was said in a direct message, or in a chat only some people can read, stays in that chat.",
    );
  });
});
