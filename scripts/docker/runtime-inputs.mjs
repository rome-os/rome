// What the runtime image is built from: the repository paths
// prepare-runtime-workspace.mjs copies into the Docker build context, and the
// files it drops on the way. The release notes read the same rules to tell
// which commits change the image, so the two never disagree. Paths here use
// "/", as git prints them.

export const rootFiles = [
  ".dockerignore",
  "Caddyfile",
  "Dockerfile",
  "package.json",
  "pnpm-lock.yaml",
  "sshd_config",
  "tsconfig.json",
  "tsconfig.scripts.build.json",
];

export const runtimePackages = [
  "packages/api-types",
  "packages/lib",
  "packages/web-content",
  "packages/core",
  "packages/discord-cli",
  "packages/signer",
  "packages/rome-node-cli",
  "packages/rome-node-core",
  "packages/rome-node-ui",
  "packages/ui",
  "packages/web",
  "packages/app-web-sdk",
  "packages/app-runtime-sdk",
];

export const optionalRuntimePackages = ["packages/app-template"];

export const forbiddenPackages = ["packages/desktop", "packages/pantheon", "packages/cdp-client"];

export const rootScripts = [
  "scripts/bundle-docker-core.mjs",
  "scripts/obfuscate-docker-runtime.mjs",
  "scripts/generate-caddyfile.ts",
  "scripts/docker",
];

/**
 * Directories copied whole, each for its own reason (see
 * prepare-runtime-workspace.mjs): apps, example apps and OpenCLI plugins ship
 * as source, infra/chrome holds the browser policy, and docs/ is what the main
 * agent answers from.
 */
export const sourceDirs = ["rome_apps", "example_apps", "opencli-plugins", "infra/chrome", "docs"];

/** Root files the build context's own copies are generated from. */
export const generatorInputs = ["pnpm-workspace.yaml"];

// Contributor-only docs stay out of the image. northstars/ and adrs/ describe
// goals and past options rather than what Rome does, so an agent answering the
// guardian from them would claim features that do not exist.
export const excludedDocsPaths = [
  "docs/adrs",
  "docs/assets",
  "docs/authoring",
  "docs/northstars",
  "docs/screenshots",
  "docs/ui",
  "docs/AGENTS.md",
  "docs/CLAUDE.md",
  "docs/dashboard-mock-mode.md",
  "docs/design-system.md",
  "docs/midscene-e2e-cases.md",
  "docs/midscene-e2e-plan.md",
  "docs/storybook.md",
  "docs/ui-kit.md",
];

export const ignoredNames = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

export const ignoredFileSuffixes = [
  ".test.ts",
  ".test.tsx",
  ".integration.test.ts",
  ".integration.test.tsx",
  ".e2e.test.ts",
  ".e2e.test.tsx",
  ".tsbuildinfo",
];

const within = (file, root) => file === root || file.startsWith(`${root}/`);

/** Whether a copied path's file is dropped on the way into the image. */
export function droppedFromCopy(file) {
  if (file.split("/").some((part) => ignoredNames.has(part))) return true;
  if (excludedDocsPaths.some((excluded) => within(file, excluded))) return true;
  return ignoredFileSuffixes.some((suffix) => file.endsWith(suffix));
}

/** Whether a repository file, as git names it, goes into the image's build context. */
export function isRuntimeInput(file) {
  const copied = [
    ...rootFiles,
    ...runtimePackages,
    ...optionalRuntimePackages,
    ...rootScripts,
    ...sourceDirs,
    ...generatorInputs,
  ].some((root) => within(file, root));
  return copied && !droppedFromCopy(file);
}
