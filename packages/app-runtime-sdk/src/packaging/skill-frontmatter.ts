export interface SkillFrontmatter {
  name: string;
  description: string;
  tools?: string[];
}

export type SkillFrontmatterErrorReason =
  | "missing-frontmatter"
  | "missing-name"
  | "missing-description"
  | "name-has-whitespace"
  | "name-has-reserved-separator";

export type SkillFrontmatterResult =
  | { ok: true; value: SkillFrontmatter }
  | { ok: false; reason: SkillFrontmatterErrorReason; message: string };

export function parseSkillFrontmatterResult(content: string): SkillFrontmatterResult {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {
      ok: false,
      reason: "missing-frontmatter",
      message: "missing a leading `---` frontmatter block",
    };
  }

  const frontmatter = match[1];
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const toolsMatch = frontmatter.match(/^tools:\s*\[([^\]]*)\]$/m)?.[1];
  const tools = toolsMatch
    ? toolsMatch
        .split(",")
        .map((tool) => tool.trim().replace(/['"]/g, ""))
        .filter(Boolean)
    : undefined;

  if (!name) return { ok: false, reason: "missing-name", message: "missing a `name` field" };
  if (!description) {
    return {
      ok: false,
      reason: "missing-description",
      message: "missing a `description` field",
    };
  }
  if (/\s/.test(name)) {
    return {
      ok: false,
      reason: "name-has-whitespace",
      message: `name must be a single token with no whitespace (got ${JSON.stringify(
        name,
      )}); use a slug like "story_authoring" and keep the display title in the body`,
    };
  }
  if (name.includes(":")) {
    return {
      ok: false,
      reason: "name-has-reserved-separator",
      message: `name must not contain ":" because it is reserved for artifact namespaces (got ${JSON.stringify(name)})`,
    };
  }
  return { ok: true, value: { name, description, tools } };
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const result = parseSkillFrontmatterResult(content);
  return result.ok ? result.value : null;
}
