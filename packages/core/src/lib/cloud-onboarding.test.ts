/**
 * What the signup survey on the Cloud whoami account turns into. Pins that a
 * missing, partial or old-row survey reads as nothing rather than an error,
 * that free text stays on one line and is cut, and that the Concierge's input
 * carries facts only, with every value escaped.
 */
import { describe, expect, it } from "@rstest/core";
import { backgroundNote, onboardingInput, readOnboardingSurvey } from "./cloud-onboarding.js";

const FULL = {
  professionalBackground: "design",
  professionalBackgroundOther: null,
  buildGoals: ["personal_tools", "  ", 7, "client work"],
  buildDescription: "  a   portfolio\nsite ",
  guardianName: " Mei ",
  agentName: "Kiki",
  watch: { gmail: true, github: false },
};

describe("readOnboardingSurvey", () => {
  it.each([
    undefined,
    {},
    { survey: null },
    { survey: "x" },
    { survey: [] },
    { survey: {} },
  ])("reads no survey from %j", (profile) => {
    expect(readOnboardingSurvey(profile as Record<string, unknown> | undefined)).toBeNull();
  });

  it("reads the answers, trimmed, with the profession in words", () => {
    expect(readOnboardingSurvey({ survey: FULL })).toEqual({
      guardianName: "Mei",
      agentName: "Kiki",
      profession: "Design",
      buildGoals: ["personal tools", "client work"],
      buildDescription: "a portfolio site",
      watch: ["gmail"],
    });
  });

  it("prefers the other-profession text, and reads an unknown profession as none", () => {
    const other = readOnboardingSurvey({
      survey: { professionalBackground: "other", professionalBackgroundOther: "Beekeeper" },
    });
    expect(other?.profession).toBe("Beekeeper");
    const unknown = readOnboardingSurvey({
      survey: { professionalBackground: "astronaut", guardianName: "Mei" },
    });
    expect(unknown?.profession).toBeNull();
  });

  it("reads an old row's nulls as empty", () => {
    expect(
      readOnboardingSurvey({
        survey: {
          professionalBackground: "student",
          guardianName: null,
          agentName: null,
          buildGoals: null,
          buildDescription: null,
          watch: null,
        },
      }),
    ).toEqual({
      guardianName: null,
      agentName: null,
      profession: "Student",
      buildGoals: [],
      buildDescription: null,
      watch: [],
    });
  });

  it("asks to follow only what is exactly true", () => {
    expect(
      readOnboardingSurvey({ survey: { watch: { gmail: true, github: true } } })?.watch,
    ).toEqual(["gmail", "github"]);
    expect(
      readOnboardingSurvey({ survey: { guardianName: "Mei", watch: { gmail: "yes", github: 1 } } })
        ?.watch,
    ).toEqual([]);
  });

  it("cuts a long free-text answer", () => {
    const survey = readOnboardingSurvey({ survey: { buildDescription: "x".repeat(5000) } });
    expect(survey?.buildDescription).toHaveLength(600);
    expect(survey?.buildDescription?.endsWith("…")).toBe(true);
  });
});

describe("backgroundNote", () => {
  it("lists the fields that have an answer", () => {
    expect(backgroundNote(readOnboardingSurvey({ survey: FULL }))).toBe(
      [
        "- Profession: Design",
        "- Wants to build: personal tools, client work",
        "- In their words: a portfolio site",
      ].join("\n"),
    );
  });

  it("skips the empty fields", () => {
    expect(backgroundNote(readOnboardingSurvey({ survey: { buildDescription: "A reader" } }))).toBe(
      "- In their words: A reader",
    );
  });

  it("is null when the survey told nothing, or there is none", () => {
    expect(backgroundNote(null)).toBeNull();
    expect(backgroundNote(readOnboardingSurvey({ survey: { guardianName: "Mei" } }))).toBeNull();
  });
});

describe("onboardingInput", () => {
  it("carries the guardian, the profession and what to follow", () => {
    expect(onboardingInput(readOnboardingSurvey({ survey: FULL }), "Mei")).toBe(
      '<onboarding guardian="Mei" profession="Design" follow="gmail"/>',
    );
  });

  it("carries only the guardian without a survey", () => {
    expect(onboardingInput(null, "Mei")).toBe('<onboarding guardian="Mei"/>');
  });

  it("escapes what a person typed", () => {
    expect(onboardingInput(null, 'Mei "><evil/>')).toBe(
      '<onboarding guardian="Mei &quot;&gt;&lt;evil/&gt;"/>',
    );
  });
});
