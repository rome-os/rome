// @rstest-environment jsdom
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "@rstest/core";
import { ROLE_CLASS, ROLES } from "./TypographyPage";

// The kit deliberately doesn't export `TYPOGRAPHY_ROLES` (it isn't published
// API), so the specimen page carries its own role list. That list must track
// the stylesheet in both directions: a role added to the kit but missing here
// would silently break the page's "every role" guarantee, and a role removed
// from the kit would leave the specimen rendering a utility that no longer
// exists. The stylesheet is the published artifact, so it is the reference.

const stylesheet = readFileSync(
  createRequire(import.meta.url).resolve("@rome-os/ui/styles.css"),
  "utf8",
);

// Role variables are `--text-<role>:`; sub-keys (`--text-<role>--line-height:`)
// carry a double hyphen in the captured name and are filtered out.
const declaredRoles = [
  ...new Set(
    [...stylesheet.matchAll(/--text-([a-z0-9-]+?):/g)]
      .map((match) => match[1])
      .filter((name) => !name.includes("--")),
  ),
];

describe("typography specimen role coverage", () => {
  it("renders exactly the roles the kit stylesheet declares", () => {
    expect([...ROLES].sort()).toEqual([...declaredRoles].sort());
  });

  it("applies each role through its own utility class", () => {
    for (const role of ROLES) {
      expect(ROLE_CLASS[role]).toBe(`text-${role}`);
    }
  });
});
