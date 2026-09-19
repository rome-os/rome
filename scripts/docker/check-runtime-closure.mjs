#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const workspace = path.join(repoRoot, ".docker/rome-runtime-workspace");
const imageTag = process.env.ROME_DOCKER_CLOSURE_IMAGE_TAG ?? "rome:closure-check";

const forbiddenPackagePaths = ["packages/desktop", "packages/pantheon", "packages/cdp-client"];
const allowedWorkspaceGlobs = [
  "packages/api-types",
  "packages/lib",
  "packages/web-content",
  "packages/core",
  "packages/discord-cli",
  "packages/rome-node",
  "packages/ui",
  "packages/web",
  "packages/app-web-sdk",
  "packages/app-runtime-sdk",
  "packages/app-template",
  "rome_apps/*",
];

const installFilters = [
  "--filter",
  "@rome/core...",
  "--filter",
  "@rome/discord-cli...",
  "--filter",
  "rome-web...",
  "--filter",
  "@rome-os/app-web-sdk...",
  "--filter",
  "@rome-os/app-runtime...",
  "--filter",
  "./rome_apps/*...",
];

async function main() {
  run("node", ["scripts/docker/prepare-runtime-workspace.mjs"], { cwd: repoRoot });

  assertForbiddenPathsAbsent();
  await assertWorkspaceBoundary();
  await assertImportBoundary();

  run("pnpm", ["install", "--frozen-lockfile", ...installFilters], { cwd: workspace });
  run("pnpm", ["--filter", "@rome/discord-cli", "typecheck"], { cwd: workspace });
  run("pnpm", ["--filter", "@rome-os/node", "typecheck"], { cwd: workspace });
  run("pnpm", ["--filter", "@rome/core", "typecheck"], { cwd: workspace });
  run("pnpm", ["--filter", "rome-web", "build"], { cwd: workspace });

  run("docker", ["build", "--file", "Dockerfile", "--tag", imageTag, workspace], {
    cwd: workspace,
  });
  run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    imageTag,
    "-lc",
    [
      "set -eu",
      'for path in /app/packages/desktop /app/packages/pantheon /app/packages/cdp-client /opt/rome/packages/desktop /opt/rome/packages/pantheon /opt/rome/packages/cdp-client; do [ ! -e "$path" ] || { echo "Forbidden path present: $path" >&2; exit 1; }; done',
      'for name in rome-desktop rome-pantheon rome-cdp-client @rome-os/pantheon-cli; do ! find /app/node_modules /opt/rome/node_modules -path "*$name*" -print -quit 2>/dev/null | grep -q . || { echo "Forbidden dependency present: $name" >&2; exit 1; }; done',
      // docker-entrypoint.sh silently skips opencli plugin registration when the
      // dir is absent, so assert it shipped rather than trusting the boot path.
      '[ -f /opt/rome/opencli-plugins/twitter/opencli-plugin.json ] || { echo "Missing /opt/rome/opencli-plugins/twitter (opencli plugins absent from image)" >&2; exit 1; }',
      'node /opt/rome/packages/discord-cli/bin/discord.js help >/dev/null || { echo "Discord CLI is not runnable" >&2; exit 1; }',
      'node /opt/rome/packages/rome-node/bin/rome-node.js --help >/dev/null || { echo "Rome Node CLI is not runnable" >&2; exit 1; }',
    ].join("\n"),
  ]);

  console.log("Docker runtime closure check passed.");
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(" ")}`);
  execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    stdio: "inherit",
    env: process.env,
  });
}

function assertForbiddenPathsAbsent() {
  const present = forbiddenPackagePaths.filter((packagePath) =>
    existsSync(path.join(workspace, packagePath)),
  );
  if (present.length > 0) {
    throw new Error(
      `Forbidden package path(s) present in runtime workspace: ${present.join(", ")}`,
    );
  }
}

async function assertWorkspaceBoundary() {
  const workspaceYaml = await readFile(path.join(workspace, "pnpm-workspace.yaml"), "utf8");
  for (const expected of allowedWorkspaceGlobs) {
    if (!workspaceYaml.includes(`"${expected}"`)) {
      throw new Error(`Missing workspace entry in generated pnpm-workspace.yaml: ${expected}`);
    }
  }

  const manifest = JSON.parse(
    await readFile(path.join(workspace, "closure-manifest.json"), "utf8"),
  );
  const invalidPackage = manifest.workspacePackages.find(
    (entry) => !isAllowedWorkspacePackage(entry.path),
  );
  if (invalidPackage) {
    throw new Error(`Unexpected workspace package in runtime closure: ${invalidPackage.path}`);
  }
}

function isAllowedWorkspacePackage(packagePath) {
  if (
    packagePath === "packages/api-types" ||
    packagePath === "packages/lib" ||
    packagePath === "packages/web-content" ||
    packagePath === "packages/core" ||
    packagePath === "packages/discord-cli" ||
    packagePath === "packages/rome-node" ||
    packagePath === "packages/ui" ||
    packagePath === "packages/web" ||
    packagePath === "packages/app-web-sdk" ||
    packagePath === "packages/app-runtime-sdk" ||
    packagePath === "packages/app-template"
  ) {
    return true;
  }

  const parts = packagePath.split("/");
  return parts.length === 2 && parts[0] === "rome_apps";
}

async function assertImportBoundary() {
  const forbiddenPackageNames = await readForbiddenPackageNames();
  const roots = [
    "packages/lib",
    "packages/web-content",
    "packages/core",
    "packages/discord-cli",
    "packages/rome-node",
    "packages/ui",
    "packages/web",
    "packages/app-web-sdk",
    "packages/app-runtime-sdk",
    "rome_apps",
  ];
  const violations = [];

  for (const root of roots) {
    for (const filePath of await listSourceFiles(path.join(workspace, root))) {
      const text = await readFile(filePath, "utf8");
      for (const importPath of extractImportPaths(text)) {
        if (forbiddenPackageNames.has(importPath) || isForbiddenRelativePackageImport(importPath)) {
          violations.push(`${path.relative(workspace, filePath)} -> ${importPath}`);
        }
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(`Forbidden Docker runtime import(s):\n${violations.join("\n")}`);
  }
}

async function readForbiddenPackageNames() {
  const names = new Set();
  for (const packagePath of forbiddenPackagePaths) {
    const packageJsonPath = path.join(repoRoot, packagePath, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (typeof packageJson.name === "string") {
      names.add(packageJson.name);
    }
  }
  return names;
}

async function listSourceFiles(root) {
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      files.push(...(await listSourceFiles(entryPath)));
    } else if (/\.(cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function extractImportPaths(text) {
  const importPaths = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      importPaths.add(match[1]);
    }
  }
  return importPaths;
}

function isForbiddenRelativePackageImport(importPath) {
  return /(^|\/)packages\/(desktop|pantheon|cdp-client)(\/|$)/.test(importPath);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
