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
    const keys = REFUSALS.map((send) => sendRefusalKey(send, "telegram"));
    expect(new Set(keys).size).toBe(REFUSALS.length);
  });

  it("keys unsupported on the channel, because it means a different thing per channel", () => {
    // LinkedIn is an inbox Rome mirrors and cannot write to; a channel Rome has
    // not taught to send is a gap that will close. Reading them the same way
    // would tell a guardian to wait for something that is never coming.
    expect(sendRefusalKey("unsupported", "linkedin")).not.toBe(
      sendRefusalKey("unsupported", "discord"),
    );
  });

  it("falls back for a channel with no line of its own, the way the glyph lookup does", () => {
    // The branch every channel added after this was written lands in — including
    // one a Rome App brings, which has no entry here to add.
    expect(sendRefusalKey("unsupported", "discord")).toBe(
      sendRefusalKey("unsupported", "some-app-channel"),
    );
  });

  it("does not key the other two on the channel — neither is a fact about one", () => {
    for (const send of ["not-connected", "no-conversation"] as const) {
      expect(sendRefusalKey(send, "linkedin")).toBe(sendRefusalKey(send, "whatsapp"));
    }
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
        for (const channel of ["linkedin", "discord", "whatsapp"]) {
          const key = sendRefusalKey(send, channel);
          const line = t(key, { channel: "Discord" });
          expect(line).not.toBe(key);
          expect(line).not.toContain("{{channel}}");
        }
      }
      await i18n.changeLanguage("en");
    });
  }
});
