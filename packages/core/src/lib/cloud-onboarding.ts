// What Rome Cloud's signup survey hands to a new instance. Rome Cloud asks the
// questions before the instance exists and returns the answers on the whoami
// account as `survey`; the first Cloud sign-in turns them into the guardian's
// and the agent's names, a short background note in memory, and the Concierge's
// first turn. Everything here is a pure read of that record: a missing or
// partial survey (an older Cloud, an old row) reads as nothing, never an error.

import { readCloudProfile, type CloudProfile } from "./cloud-profile.js";

/** The profession answers Rome Cloud offers, as the guardian reads them. */
const PROFESSION_LABELS: Record<string, string> = {
  technical: "Technical",
  product: "Product",
  design: "Design",
  business_operations: "Business and operations",
  healthcare: "Healthcare",
  education_research: "Education and research",
  student: "Student",
};

/** The longest free-text answer kept: it lands in memory and in a prompt. */
const TEXT_MAX_LENGTH = 600;

export interface OnboardingSurvey {
  guardianName: string | null;
  agentName: string | null;
  /** The profession in words: the "other" text when set, else the answer's label. */
  profession: string | null;
  buildGoals: string[];
  buildDescription: string | null;
  /** The services the guardian asked Rome to follow, by the name the survey uses. */
  watch: ("gmail" | "github")[];
}

/** One line of plain text: whitespace collapsed, cut at {@link TEXT_MAX_LENGTH}. */
function plain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > TEXT_MAX_LENGTH ? `${text.slice(0, TEXT_MAX_LENGTH - 1)}…` : text;
}

function wordsOf(id: string): string {
  return id.replace(/[_-]+/g, " ");
}

/**
 * The survey on a Cloud profile, or null when the profile carries none. Reads
 * each field defensively: Rome Cloud sends nulls for what an old row never
 * answered, and a Cloud older than the survey sends no `survey` at all.
 */
export function readOnboardingSurvey(profile: CloudProfile | undefined): OnboardingSurvey | null {
  const survey = readCloudProfile(profile?.survey);
  if (Object.keys(survey).length === 0) return null;
  const background =
    typeof survey.professionalBackground === "string" ? survey.professionalBackground : null;
  const other = plain(survey.professionalBackgroundOther);
  const watch = readCloudProfile(survey.watch);
  return {
    guardianName: plain(survey.guardianName),
    agentName: plain(survey.agentName),
    profession: other ?? (background ? (PROFESSION_LABELS[background] ?? null) : null),
    buildGoals: Array.isArray(survey.buildGoals)
      ? survey.buildGoals.flatMap((goal) => {
          const text = plain(goal);
          return text ? [wordsOf(text)] : [];
        })
      : [],
    buildDescription: plain(survey.buildDescription),
    watch: [
      ...(watch.gmail === true ? (["gmail"] as const) : []),
      ...(watch.github === true ? (["github"] as const) : []),
    ],
  };
}

/** The `## Background` note's body for GUARDIAN.md, or null when the survey told nothing. */
export function backgroundNote(survey: OnboardingSurvey | null): string | null {
  if (!survey) return null;
  const lines = [
    survey.profession ? `- Profession: ${survey.profession}` : null,
    survey.buildGoals.length > 0 ? `- Wants to build: ${survey.buildGoals.join(", ")}` : null,
    survey.buildDescription ? `- In their words: ${survey.buildDescription}` : null,
  ].filter((line): line is string => line !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * The Concierge's first input: who just signed up and which services they
 * asked it to follow. What to do with it is the Concierge's `<onboarding>`
 * rule, so the input carries facts only.
 */
export function onboardingInput(survey: OnboardingSurvey | null, guardianName: string): string {
  const fields = [
    `guardian="${attr(guardianName)}"`,
    ...(survey?.profession ? [`profession="${attr(survey.profession)}"`] : []),
    ...(survey && survey.watch.length > 0 ? [`follow="${survey.watch.join(", ")}"`] : []),
  ];
  return `<onboarding ${fields.join(" ")}/>`;
}
