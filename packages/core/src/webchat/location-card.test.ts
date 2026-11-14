import { describe, expect, it } from "@rstest/core";
import {
  chatReadByGuardianAlone,
  locationAnswerPrompt,
  sharedLocationAnswer,
} from "./location-card.js";

describe("chatReadByGuardianAlone", () => {
  const concierge = { id: "c", agentName: "core:concierge", ownerKey: null, triggerKind: null };
  const common = { id: "x", agentName: null, ownerKey: null, triggerKind: null };

  it("reads the guardian's private chats as theirs alone, whoever else may open the dashboard", () => {
    expect(chatReadByGuardianAlone(concierge, true)).toBe(true);
    expect(chatReadByGuardianAlone({ ...concierge, ownerKey: "visitor:a" }, false)).toBe(false);
  });

  it("reads a common chat as the guardian's alone only while no visitor may open the dashboard", () => {
    expect(chatReadByGuardianAlone(common, false)).toBe(true);
    expect(chatReadByGuardianAlone(common, true)).toBe(false);
    expect(chatReadByGuardianAlone(null, false)).toBe(false);
  });
});

describe("the share-location answer", () => {
  it("keeps a position and rounds its accuracy", () => {
    expect(
      sharedLocationAnswer({ latitude: 1.5, longitude: -2, accuracy: 10.6, timestamp: 0 }),
    ).toEqual({
      status: "shared",
      latitude: 1.5,
      longitude: -2,
      accuracyMeters: 11,
      fixedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  it("takes no position that is missing or out of range", () => {
    expect(sharedLocationAnswer({})).toBeNull();
    expect(
      sharedLocationAnswer({ latitude: 0, longitude: 181, accuracy: 1, timestamp: 0 }),
    ).toBeNull();
    expect(
      sharedLocationAnswer({ latitude: "1", longitude: 1, accuracy: 1, timestamp: 0 }),
    ).toBeNull();
    expect(
      sharedLocationAnswer({ latitude: 0, longitude: 0, accuracy: -1, timestamp: 0 }),
    ).toBeNull();
  });

  it("tells the agent to name only the area when the fix is coarse", () => {
    const answer = (accuracyMeters: number) =>
      locationAnswerPrompt({
        status: "shared",
        latitude: 1,
        longitude: 2,
        accuracyMeters,
        fixedAt: "t",
      });
    expect(answer(25)).not.toContain("around <city>");
    expect(answer(25_000)).toContain("around <city>");
  });

  it("tells the agent a decline covers that message only", () => {
    const prompt = locationAnswerPrompt({ status: "declined", dismissed: true });
    expect(prompt).toContain("Don't show the card again for it");
    expect(prompt).toContain("when a later message again needs where they are now");
  });
});
