import { beforeAll, describe, expect, it } from "@rstest/core";
import type { TFunction } from "i18next";
import i18n from "@/i18n";
import { sendRefusalKey, type RefusedSendState } from "./send-copy";

// The copy rule for a refused send. What is under test is that no reason string
// crosses the wire and none has to: the server names which refusal it is, this
// answers a key, and every locale carries that key.

const REFUSALS: RefusedSendState[] = ["not-connected", "unsupported", "no-conversation"];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("sendRefusalKey", () => {
  it("answers a distinct key for each way a channel cannot be written to", () => {
    const keys = REFUSALS.map((send) => sendRefusalKey(send));
    expect(new Set(keys).size).toBe(REFUSALS.length);
  });
});

describe("the locales behind those keys", () => {
  // Both, not just the one the tests run in: a key that only English carries is
  // a reason that renders as its own key for every other reader.
  for (const language of ["en", "zh-CN"]) {
    it(`answers every key in ${language}, naming the channel`, async () => {
      await i18n.changeLanguage(language);
      const t = i18n.getFixedT(language, "people") as TFunction<"people">;
      for (const send of REFUSALS) {
        for (const channel of ["LinkedIn", "Discord", "WhatsApp"]) {
          const key = sendRefusalKey(send);
          const line = t(key, { channel });
          expect(line).not.toBe(key);
          expect(line).not.toContain("{{channel}}");
        }
      }
      await i18n.changeLanguage("en");
    });
  }
});
