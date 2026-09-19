/**
 * Pins the [app token boundary](../docs/design-system.md#two-layers).
 * The roster lives in `packages/ui/src/token-contract.ts`.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";
import { compileTailwindCss, parseCss } from "./tailwind-policy.mjs";

const repoRoot = join(import.meta.dirname, "..");

const TOKEN_REFERENCE = /var\(\s*(--[a-z0-9-]+)/gi;

// Component libraries set these on rendered elements. Tailwind supplies the
// four font defaults as optional fallbacks instead of host requirements.
const BUNDLE_RUNTIME_TOKENS = new Set([
  "--default-font-feature-settings",
  "--default-font-variation-settings",
  "--default-mono-font-feature-settings",
  "--default-mono-font-variation-settings",
  "--radix-context-menu-content-available-height",
  "--radix-context-menu-content-transform-origin",
  "--radix-dropdown-menu-content-available-height",
  "--radix-dropdown-menu-content-transform-origin",
  "--radix-popover-content-transform-origin",
  "--radix-select-content-available-height",
  "--radix-select-content-transform-origin",
  "--radix-select-trigger-height",
  "--radix-select-trigger-width",
  "--radix-tooltip-content-transform-origin",
  "--toast-close-button-end",
  "--toast-close-button-start",
  "--toast-close-button-transform",
  "--width",
]);

const referencedTokens = (value) =>
  new Set([...value.matchAll(TOKEN_REFERENCE)].map((match) => match[1]));

function addAlias(aliases, name, value) {
  const references = referencedTokens(value);
  if (references.size === 0) return;
  const targets = aliases.get(name) ?? new Set();
  for (const reference of references) targets.add(reference);
  aliases.set(name, targets);
}

export function collectAliases(cssRoot, aliases) {
  cssRoot.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) {
      addAlias(aliases, declaration.prop, declaration.value);
    }
  });
}

/** Expand every referenced host alias until the graph reaches literal values. */
export function closeOverAliases(seed, aliases) {
  const closed = new Set(seed);
  const queue = [...closed];

  while (queue.length > 0) {
    const name = queue.pop();
    for (const target of aliases.get(name) ?? []) {
      if (closed.has(target)) continue;
      closed.add(target);
      queue.push(target);
    }
  }

  return new Set([...closed].sort());
}

async function readHostAliases(root) {
  const sdkDir = join(root, "packages", "app-web-sdk");
  const aliases = new Map();

  const globalsPath = join(root, "packages", "web", "src", "globals.css");
  const globalsCss = await parseCss(readFileSync(globalsPath, "utf8"), {
    dependencyRoot: sdkDir,
    from: globalsPath,
  });
  collectAliases(globalsCss, aliases);

  const themeModule = await tsImport(
    join(root, "packages", "web", "src", "lib", "theme.ts"),
    import.meta.url,
  );
  const themeCss = themeModule.buildThemeCss(themeModule.getThemeDefinitions());
  const parsedThemeCss = await parseCss(themeCss, {
    dependencyRoot: sdkDir,
    from: join(root, "packages", "web", "src", "lib", "generated-theme.css"),
  });
  collectAliases(parsedThemeCss, aliases);

  return aliases;
}

function unresolvedReferences(cssRoot) {
  const referenced = new Set();
  const defined = new Set();

  cssRoot.walkDecls((declaration) => {
    if (declaration.prop.startsWith("--")) defined.add(declaration.prop);
    for (const token of referencedTokens(declaration.value)) referenced.add(token);
  });
  cssRoot.walkAtRules("property", (rule) => {
    const name = rule.params.trim().split(/\s+/, 1)[0];
    if (name.startsWith("--")) defined.add(name);
  });

  return new Set(
    [...referenced]
      .filter((name) => !defined.has(name))
      .filter((name) => !BUNDLE_RUNTIME_TOKENS.has(name))
      .sort(),
  );
}

async function compileAppCss(root) {
  const sdkDir = join(root, "packages", "app-web-sdk");
  const workDir = mkdtempSync(join(tmpdir(), "rome-token-contract-"));
  const scopeDir = join(workDir, "node_modules", "@rome-os");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync(sdkDir, join(scopeDir, "app-web-sdk"), "dir");

  const entry = join(workDir, "styles.css");
  const appsDir = join(root, "rome_apps");
  const appSources = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(appsDir, entry.name, "src", "web"))
    .filter((directory) => existsSync(directory))
    .sort();
  const templateSources = ["template", "workflow"]
    .map((name) => join(root, "packages", "app-template", name, "src", "web"))
    .filter((directory) => existsSync(directory))
    .sort();
  const css = [
    '@import "@rome-os/app-web-sdk/styles";',
    `@source "${join(root, "packages", "ui", "src")}";`,
    ...templateSources.map((directory) => `@source "${directory}";`),
    ...appSources.map((directory) => `@source "${directory}";`),
  ].join("\n");
  writeFileSync(entry, css);

  try {
    return await compileTailwindCss({
      entry,
      css,
      base: workDir,
      dependencyRoot: sdkDir,
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** The complete custom-property surface app artifacts require from the host. */
export async function findInheritedTokens(root = repoRoot) {
  const [compiled, aliases] = await Promise.all([compileAppCss(root), readHostAliases(root)]);
  return closeOverAliases(unresolvedReferences(compiled.root), aliases);
}

export async function readInheritedTokens(root = repoRoot) {
  const path = join(root, "packages", "ui", "src", "token-contract.ts");
  const { INHERITED_TOKENS: values } = await tsImport(path, import.meta.url);
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.some((value) => typeof value !== "string")
  ) {
    throw new Error(`INHERITED_TOKENS is missing or invalid in ${path}`);
  }
  const tokens = [...values];
  if (new Set(tokens).size !== tokens.length) {
    throw new Error("INHERITED_TOKENS must be unique");
  }
  return new Set(tokens);
}

export function compareTokenContract(actual, expected) {
  return {
    missingFromRoster: [...actual].filter((token) => !expected.has(token)).sort(),
    absentFromBundles: [...expected].filter((token) => !actual.has(token)).sort(),
  };
}

export function formatContractMismatch({ missingFromRoster, absentFromBundles }) {
  const sections = [];
  if (missingFromRoster.length > 0) {
    sections.push(
      "App bundles depend on tokens missing from INHERITED_TOKENS:\n" +
        missingFromRoster.map((token) => `  ${token}`).join("\n"),
    );
  }
  if (absentFromBundles.length > 0) {
    sections.push(
      "INHERITED_TOKENS lists tokens absent from app bundles:\n" +
        absentFromBundles.map((token) => `  ${token}`).join("\n"),
    );
  }
  return sections.join("\n\n");
}
