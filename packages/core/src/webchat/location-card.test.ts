import { describe, expect, it } from "@rstest/core";
import { mayAutoShare } from "@rome/api-types/location-card";
import {
  locationAnswerPrompt,
  locationCardUiFromProps,
  sharedLocationAnswer,
} from "./location-card.js";

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

describe("the card a stored share-location card draws", () => {
  it("marks it to share by itself only when its props say so", () => {
    expect(
      mayAutoShare(locationCardUiFromProps({ reason: "r", autoShare: true }) ?? undefined),
    ).toBe(true);
    // An older card, or one a turn the guardian did not start showed, waits for Share.
    expect(mayAutoShare(locationCardUiFromProps({ reason: "r" }) ?? undefined)).toBe(false);
  });
});
