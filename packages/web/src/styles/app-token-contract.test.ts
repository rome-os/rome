import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { getThemeDefinitions } from "@/lib/theme";

/**
 * The host→app custom-property contract. Rule and rationale:
 * docs/design-system.md, "Only theme values cross the Shadow DOM boundary".
 *
 * Resolution here is by name, not by value. An app may pin a constant to its
 * own value, which the app template invites, and divergence from the kit is the
 * app's call. Sourcing a name from the host by accident is not.
 */

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

/** Directories holding a workspace of app packages, each `<pkg>/src/web`. */
const APP_ROOTS = ["rome_apps", "example_apps", "packages/app-template"];

/** Stylesheets that carry the design-system canon into an app's own bundle.
 *  Importing either puts the kit's `:host` constants (and Tailwind's theme
 *  keys, which v4 emits on `:root, :host`) inside the app's shadow root, so the
 *  app resolves them without reaching past the boundary. */
const CANON_IMPORTS = ["@rome-os/app-web-sdk/styles", "@rome-os/ui/styles.css"];

/** Families Tailwind generates into the importing bundle rather than the kit
 *  source: its own default theme keys and the `--tw-*` internals utilities set
 *  on the elements they apply to. Only consulted for an app that imports the
 *  canon, which is what pulls Tailwind in. */
const TAILWIND_FAMILIES = [/^--tw-/, /^--spacing(-|$)/, /^--default-/, /^--breakpoint-/];

function stripComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

function declaredNames(css: string): Set<string> {
  return new Set(
    [...stripComments(css).matchAll(/(?:^|[;{}\s])(--[a-zA-Z0-9_-]+)\s*:/g)].map((m) => m[1]),
  );
}

/** Names the sheet reads with no fallback. A `var(--x, …)` is exempt: the app
 *  has stated what the property means when nothing supplies it, so it is not
 *  relying on the host to. That also covers a property the app sets from JS as
 *  an inline style, which no stylesheet declares. */
function referencedNames(css: string): Set<string> {
  return new Set(
    [...stripComments(css).matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g)]
      .filter((m) => m[2] === ")")
      .map((m) => m[1]),
  );
}

function cssFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return extname(path) === ".css" ? [path] : [];
  });
}

/** Every name `buildThemeCss` emits, across every registered theme: the palette
 *  primitives plus both mapping halves. Derived from the definitions rather than
 *  listed here, so adding a theme token widens the contract automatically and
 *  removing one narrows it — which is the point, since a dropped token is
 *  exactly the change that would silently break an app. */
function themeContract(): Set<string> {
  const names = new Set<string>();
  for (const theme of getThemeDefinitions()) {
    for (const tokens of [theme.palette, theme.light, theme.dark]) {
      for (const name of Object.keys(tokens)) names.add(`--${name}`);
    }
  }
  return names;
}

function kitNames(): Set<string> {
  return declaredNames(readFileSync(resolve(repoRoot, "packages/ui/src/styles.css"), "utf8"));
}

interface AppSources {
  name: string;
  files: { path: string; css: string }[];
}

function appSources(): AppSources[] {
  return APP_ROOTS.flatMap((root) => {
    const rootPath = resolve(repoRoot, root);
    if (!existsSync(rootPath)) return [];
    return readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: `${root}/${entry.name}`,
        files: cssFiles(resolve(rootPath, entry.name, "src/web")).map((path) => ({
          path,
          css: readFileSync(path, "utf8"),
        })),
      }))
      .filter((app) => app.files.length > 0);
  });
}

describe("app token contract", () => {
  const apps = appSources();

  it("finds the app stylesheets it is meant to police", () => {
    // A rename of `src/web` or of an app root would otherwise turn this whole
    // file into a green no-op.
    expect(apps.map((app) => app.name)).toContain("rome_apps/coding");
    expect(apps.length).toBeGreaterThan(5);
  });

  it("reads no custom property the host has not promised", () => {
    const contract = themeContract();
    const kit = kitNames();

    const violations = apps.flatMap((app) => {
      const importsCanon = app.files.some((file) =>
        CANON_IMPORTS.some((specifier) => file.css.includes(specifier)),
      );
      const declared = new Set(app.files.flatMap((file) => [...declaredNames(file.css)]));
      return app.files.flatMap((file) =>
        [...referencedNames(file.css)]
          .filter((name) => !declared.has(name) && !contract.has(name))
          .filter(
            (name) =>
              !importsCanon ||
              (!kit.has(name) && !TAILWIND_FAMILIES.some((family) => family.test(name))),
          )
          .map((name) => `${relative(repoRoot, file.path)}: ${name}`),
      );
    });

    expect(violations.sort()).toEqual([]);
  });
});
