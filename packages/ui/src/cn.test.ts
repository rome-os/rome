import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";
import { cn } from "./cn.js";
import { TYPOGRAPHY_ROLES } from "./typography-roles.js";

/**
 * Every role name declared in the stylesheet's `--text-*` namespace. A name is
 * hyphen-separated alphanumeric segments — digits included, since Tailwind
 * size keys are routinely named that way (`--text-2xs`). A segment may not be
 * empty, which is what keeps the per-role modifiers (`--text-aux--line-height`)
 * out: the double hyphen ends the match before the `:`.
 */
const stylesheetRoles = [
  ...readFileSync(join(import.meta.dirname, "styles.css"), "utf8").matchAll(
    /^\s*--text-([a-z0-9]+(?:-[a-z0-9]+)*):/gm,
  ),
].map(([, role]) => role);

describe("cn", () => {
  it("joins conditional class names and drops falsy ones", () => {
    expect(cn("a", false && "b", undefined, ["c", null], { d: true, e: false })).toBe("a c d");
  });

  it("lets a later Tailwind utility win over an earlier one in the same group", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
  });

  it("keeps utilities from different groups, including font size vs text color", () => {
    expect(cn("text-sm font-medium", "text-muted-foreground")).toBe(
      "text-sm font-medium text-muted-foreground",
    );
  });

  // The kit's hosts are on Tailwind 4, whose utilities tailwind-merge only
  // understands from v3 onwards. Under v2 each of these pairs survives intact,
  // so the winner is decided by generated CSS order rather than by the caller —
  // silently breaking the override contract every kit component relies on.
  // These cases pin the dependency to a Tailwind 4-aware merger.
  describe("Tailwind 4 conflict groups", () => {
    it("collapses the renamed outline utilities", () => {
      expect(cn("outline-hidden", "outline-none")).toBe("outline-none");
    });

    it("collapses a custom-property value against a scale value", () => {
      expect(cn("h-(--cell-size)", "h-10")).toBe("h-10");
    });

    it("collapses the field-sizing utilities", () => {
      expect(cn("field-sizing-content", "field-sizing-fixed")).toBe("field-sizing-fixed");
    });
  });

  // The roles are custom `--text-*` theme keys, which a stock merger doesn't
  // recognize as font sizes — it files them with the text colors instead, so a
  // caller's color deletes the role and the element renders at whatever
  // typography it inherits. These cases pin the roles to the font-size group.
  describe("typography roles", () => {
    // Set equality, not containment: a name registered with the merger but no
    // longer in the stylesheet keeps claiming the font-size group for
    // `text-<name>`, so if that name is ever reused as a color token two
    // conflicting colors survive a merge and CSS order picks the winner.
    it("registers exactly the roles the stylesheet declares", () => {
      expect(stylesheetRoles).toEqual(TYPOGRAPHY_ROLES);
    });

    it.each(stylesheetRoles)("keeps text-%s when a caller adds a text color", (role) => {
      expect(cn(`text-${role}`, "text-muted-foreground")).toBe(
        `text-${role} text-muted-foreground`,
      );
    });

    it.each(stylesheetRoles)("keeps text-%s when a base text color comes first", (role) => {
      expect(cn("text-muted-foreground", `text-${role}`)).toBe(
        `text-muted-foreground text-${role}`,
      );
    });

    it("keeps the role inside a full component class list", () => {
      expect(cn("px-2 py-1 text-aux data-inset:pl-8", "text-muted-foreground")).toBe(
        "px-2 py-1 text-aux data-inset:pl-8 text-muted-foreground",
      );
    });

    it.each(stylesheetRoles)("lets a later size utility override text-%s", (role) => {
      expect(cn(`text-${role}`, "text-sm")).toBe("text-sm");
    });

    it.each(stylesheetRoles)("lets text-%s override an earlier size utility", (role) => {
      expect(cn("text-sm", `text-${role}`)).toBe(`text-${role}`);
    });

    it("lets one role override another", () => {
      expect(cn("text-display", "text-aux")).toBe("text-aux");
    });
  });
});
