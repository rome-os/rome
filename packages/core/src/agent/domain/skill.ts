// A skill as an agent reads it. Agent model: docs/concepts/skills.md.

import { createSearchMatcher, normalizeSearchLimit } from "./catalog-search.js";

export interface Skill {
  /** The canonical id, `<app-id>:<local-name>`. */
  name: string;
  localName: string;
  description: string;
  /** The tool subset the skill asks for. */
  tools?: string[];
  /** The body, without its frontmatter. */
  content: string;
  /** Absolute skill directory; set only when the skill ships companion files. */
  directory?: string;
  /** Companion files relative to `directory` (everything except SKILL.md). */
  files?: string[];
  ownerType: "core" | "app";
  ownerId: string;
}

/** The skills an agent can read. */
export interface SkillCatalog {
  /** Read on every call, so an app installed mid-session shows at once. */
  list(): readonly Skill[];
  /** By canonical id, or a legacy bare name. */
  find(name: string): Skill | undefined;
}

interface SkillSummary {
  name: string;
  description: string;
  tools?: string[];
  ownerType: Skill["ownerType"];
  ownerId: string;
}

export function toSkillSummary(skill: Skill): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    tools: skill.tools,
    ownerType: skill.ownerType,
    ownerId: skill.ownerId,
  };
}

export function searchSkills(
  skillCatalog: readonly Skill[],
  queryText: string,
  limit: number | undefined,
): SkillSummary[] {
  const normalizedLimit = normalizeSearchLimit(limit);
  const matcher = createSearchMatcher(queryText);
  const sortedSkills = [...skillCatalog].sort((left, right) => left.name.localeCompare(right.name));

  if (!matcher) {
    return sortedSkills.slice(0, normalizedLimit).map(toSkillSummary);
  }

  return sortedSkills
    .map((skill) => {
      const haystack = [skill.name, skill.description, ...(skill.tools ?? [])].join(" ");
      if (!matcher.matches(haystack)) {
        return null;
      }

      let score = 1;
      score += matcher.scoreName(skill.name);
      score += matcher.scoreDescription(skill.description);
      if (matcher.kind === "regex" && (skill.tools ?? []).some((tool) => matcher.matches(tool))) {
        score += 1;
      }

      return { skill, score };
    })
    .filter((entry): entry is { skill: Skill; score: number } => entry !== null)
    .sort(
      (left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name),
    )
    .slice(0, normalizedLimit)
    .map(({ skill }) => toSkillSummary(skill));
}
