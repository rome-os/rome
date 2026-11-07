// The tools an agent finds and reads skills with.

import { MAX_SEARCH_LIMIT, SEARCH_LIMIT_DESCRIPTION } from "../domain/catalog-search.js";
import type { RomeTool } from "../domain/rome-tools.js";
import { searchSkills, toSkillSummary, type Skill, type SkillCatalog } from "../domain/skill.js";
import type { RomeToolRunner } from "./rome-tool-runner.js";

function requireSkill(skillCatalog: readonly Skill[], skillName: string): Skill {
  const skill = skillCatalog.find((entry) => entry.name === skillName);
  if (!skill) {
    throw new Error(`Unknown skill: ${skillName}`);
  }
  return skill;
}

function resolveSkillLookupName(args: Record<string, unknown>): string {
  const skillName = typeof args.skill_name === "string" ? args.skill_name : args.query;
  if (typeof skillName !== "string" || skillName.trim() === "") {
    throw new Error('Missing skill name. Provide "skill_name" with the exact skill name.');
  }
  return skillName;
}

/** `list_skills`, `search_skills` and `read_skill`. */
export function skillTools(skills: Pick<SkillCatalog, "list">, run: RomeToolRunner): RomeTool[] {
  return [
    {
      name: "list_skills",
      description: "List the skills available in this workspace.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: (input) =>
        run("list_skills", input, async () =>
          [...skills.list()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map(toSkillSummary),
        ),
    },
    {
      name: "search_skills",
      description:
        "Search available skills by regex against name, description, or declared tools. Supports /pattern/flags for explicit flags.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Regex pattern to match skills, for example browser|calendar, or /web(fetch|search)/i for explicit flags.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_SEARCH_LIMIT,
            description: SEARCH_LIMIT_DESCRIPTION,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: (input) =>
        run("search_skills", input, async (args) =>
          searchSkills(
            skills.list(),
            String(args.query ?? ""),
            typeof args.limit === "number" ? args.limit : undefined,
          ),
        ),
    },
    {
      name: "read_skill",
      description:
        "Read the full markdown for one available skill. When the skill ships companion files, the result also returns its `directory` and `files`; open one with your file tools only when the skill body points you to it.",
      inputSchema: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill name to read." },
          query: { type: "string", description: "Alias for skill_name. Use the exact skill name." },
        },
        additionalProperties: false,
      },
      handler: (input) =>
        run("read_skill", input, async (args) => {
          const skillName = resolveSkillLookupName(args);
          const skill = requireSkill(skills.list(), skillName);
          return {
            name: skillName,
            content: skill.content,
            ...(skill.directory && skill.files?.length
              ? { directory: skill.directory, files: skill.files }
              : {}),
          };
        }),
    },
  ];
}
