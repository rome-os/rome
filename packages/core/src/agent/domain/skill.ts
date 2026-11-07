// A skill as an agent reads it. Agent model: docs/concepts/skills.md.

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
