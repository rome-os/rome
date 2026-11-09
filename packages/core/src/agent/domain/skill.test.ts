import { describe, expect, it } from "@rstest/core";
import { searchSkills, type Skill } from "./skill.js";

function skill(name: string, description: string, tools?: string[]): Skill {
  return {
    name,
    localName: name,
    description,
    tools,
    content: "",
    ownerType: "core",
    ownerId: "core",
  };
}

describe("searchSkills", () => {
  const catalog = [
    skill("core:zeta-mail", "unrelated"),
    skill("core:alpha", "writes mail"),
    skill("core:beta", "other", ["mail_tool"]),
  ];
  const names = (query: string, limit?: number) =>
    searchSkills(catalog, query, limit).map((found) => found.name);

  it("ranks a name above a description above a tool", () => {
    expect(names("mail")).toEqual(["core:zeta-mail", "core:alpha", "core:beta"]);
  });

  it("lists by name for an empty query, up to the limit", () => {
    expect(names("", 1)).toEqual(["core:alpha"]);
  });
});
