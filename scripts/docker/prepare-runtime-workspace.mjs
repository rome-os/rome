#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const runtimeWorkspace = path.join(repoRoot, ".docker/rome-runtime-workspace");
const manifestWorkspace = path.join(runtimeWorkspace, ".docker-manifests");

const rootFiles = [
  ".dockerignore",
  "Caddyfile",
  "Dockerfile",
  "docker-entrypoint.sh",
  "package.json",
  "pnpm-lock.yaml",
  "sshd_config",
  "tsconfig.json",
  "tsconfig.scripts.build.json",
];

const runtimePackages = [
  "packages/api-types",
  "packages/lib",
  "packages/web-content",
  "packages/core",
  "packages/discord-cli",
  "packages/ui",
  "packages/web",
  "packages/app-web-sdk",
  "packages/app-runtime-sdk",
];

const optionalRuntimePackages = ["packages/app-template"];

const forbiddenPackages = [
  "packages/desktop",
  "packages/pantheon",
  "packages/cdp-client",
  "packages/mobile",
];

const rootScripts = [
  "scripts/bundle-docker-core.mjs",
  "scripts/obfuscate-docker-runtime.mjs",
  "scripts/generate-caddyfile.ts",
  "scripts/docker",
];

const runtimeWorkspacePackagesYaml = `packages:
  - "packages/api-types"
  - "packages/lib"
  - "packages/web-content"
  - "packages/core"
  - "packages/discord-cli"
  - "packages/ui"
  - "packages/web"
  - "packages/app-web-sdk"
  - "packages/app-runtime-sdk"
  - "packages/app-template"
  - "rome_apps/*"
`;

// The runtime workspace narrows `packages`, but every other setting in the
// root pnpm-workspace.yaml (allowBuilds, overrides, minimumReleaseAge, …) must
// carry over verbatim — pnpm 11 reads config only from this file, so dropping
// a key here silently changes install behavior inside the image.
async function generateWorkspaceYaml() {
  const rootYaml = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const packagesBlock = /^packages:\n(?: +- .*\n)+/m;
  if (!packagesBlock.test(rootYaml)) {
    throw new Error("Could not find the `packages:` list in the root pnpm-workspace.yaml");
  }
  return rootYaml.replace(packagesBlock, runtimeWorkspacePackagesYaml);
}

const ignoredNames = new Set([".git", ".next", ".turbo", "coverage", "dist", "node_modules"]);

const ignoredFileSuffixes = [
  ".test.ts",
  ".test.tsx",
  ".integration.test.ts",
  ".integration.test.tsx",
  ".e2e.test.ts",
  ".e2e.test.tsx",
  ".tsbuildinfo",
];

/**
 * On macOS, pnpm guards `node_modules` (and dirs it manages) with a
 * `<user> deny delete` ACL. That ACL survives into this generated workspace and
 * blocks `fs.rm({ force: true })` with EACCES — Node's rm honors ACLs and has no
 * API to strip them — so the *next* `dev:all` aborts in prepare before it can
 * recreate the workspace, breaking the idempotency this step must preserve.
 * `chmod -RN` clears every ACL in the tree; guard to Darwin and swallow errors so
 * it's a no-op everywhere else (and on a clean checkout with no prior workspace).
 */
function stripBlockingAcls(target) {
  if (process.platform !== "darwin" || !existsSync(target)) return;
  try {
    execFileSync("chmod", ["-RN", target], { stdio: "ignore" });
  } catch {
    // Best-effort: if chmod is unavailable the rm below still surfaces the error.
  }
}

async function main() {
  stripBlockingAcls(runtimeWorkspace);
  await rm(runtimeWorkspace, { recursive: true, force: true });
  await mkdir(runtimeWorkspace, { recursive: true });

  const copiedTopLevelPaths = new Set();

  for (const filePath of rootFiles) {
    await copyPath(filePath);
    copiedTopLevelPaths.add(topLevelPath(filePath));
  }

  await writeFile(
    path.join(runtimeWorkspace, "pnpm-workspace.yaml"),
    await generateWorkspaceYaml(),
    "utf8",
  );
  copiedTopLevelPaths.add("pnpm-workspace.yaml");

  for (const packagePath of runtimePackages) {
    await copyPath(packagePath);
    copiedTopLevelPaths.add(topLevelPath(packagePath));
  }

  for (const packagePath of optionalRuntimePackages) {
    if (!existsSync(path.join(repoRoot, packagePath))) {
      continue;
    }

    await copyPath(packagePath);
    copiedTopLevelPaths.add(topLevelPath(packagePath));
  }

  for (const scriptPath of rootScripts) {
    await copyPath(scriptPath);
    copiedTopLevelPaths.add(topLevelPath(scriptPath));
  }

  await copyPath("rome_apps");
  copiedTopLevelPaths.add("rome_apps");

  // Example/reference apps ship as plain SOURCE, not workspace members: they are
  // read by skills at runtime (workflow_creation -> example_apps/morning-brief)
  // and seeded into the per-profile example-apps dir at boot
  // (ensureProfileExampleAppsSeeded). Deliberately kept out of the install/build
  // closure — not added to the narrowed pnpm-workspace.yaml or
  // listWorkspacePackages — so pnpm ignores them and the workspace-boundary
  // check stays green. copyPath already drops node_modules/dist/tests, so what
  // lands is clean, buildable starter source.
  await copyPath("example_apps");
  copiedTopLevelPaths.add("example_apps");

  // OpenCLI plugins ship as plain source too: docker-entrypoint.sh registers
  // every /app/opencli-plugins/<site>/ dir with the in-container opencli at
  // boot, and silently skips registration when the dir is absent — so leaving
  // this out of the context ships an image that quietly falls back to the
  // built-in opencli commands.
  await copyPath("opencli-plugins");
  copiedTopLevelPaths.add("opencli-plugins");

  // Chrome/Chromium managed-policy JSON the Dockerfile drops into
  // /etc/opt/chrome/policies/managed (force-installs the OpenCLI extension).
  // Only the chrome/ subtree is staged: the rest of infra/ is host-side build
  // material that has no business in the runtime context.
  await copyPath("infra/chrome");
  copiedTopLevelPaths.add("infra");

  assertForbiddenPackagesAbsent();

  const workspacePackages = await listWorkspacePackages(runtimeWorkspace);
  await writeManifestWorkspace(workspacePackages);

  const manifest = {
    root: path.relative(repoRoot, runtimeWorkspace),
    copiedTopLevelPaths: [...copiedTopLevelPaths].sort(),
    workspacePackages,
  };
  await writeFile(
    path.join(runtimeWorkspace, "closure-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  console.log(`Prepared Docker runtime workspace at ${path.relative(repoRoot, runtimeWorkspace)}`);
  console.log(`Included ${workspacePackages.length} workspace package(s).`);
}

async function copyPath(relativePath) {
  const source = path.join(repoRoot, relativePath);
  if (!existsSync(source)) {
    throw new Error(`Missing required Docker runtime path: ${relativePath}`);
  }

  const destination = path.join(runtimeWorkspace, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => shouldCopy(sourcePath),
  });
}

async function writeManifestWorkspace(workspacePackages) {
  await rm(manifestWorkspace, { recursive: true, force: true });

  for (const filePath of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    await copyRuntimeWorkspacePath(filePath, path.join(manifestWorkspace, filePath));
  }

  for (const packageEntry of workspacePackages) {
    const packageJsonPath = path.join(packageEntry.path, "package.json");
    await copyRuntimeWorkspacePath(packageJsonPath, path.join(manifestWorkspace, packageJsonPath));

    // Bin scripts must be present at install time, otherwise pnpm silently
    // skips linking them into node_modules/.bin/. Copy the package's `bin/`
    // dir if it has one so workspace CLIs (e.g. @rome-os/app-web-sdk's `rome`
    // command) are resolvable during the builder stage.
    const binDir = path.join(runtimeWorkspace, packageEntry.path, "bin");
    if (existsSync(binDir)) {
      await cp(binDir, path.join(manifestWorkspace, packageEntry.path, "bin"), {
        recursive: true,
        dereference: false,
      });
    }
  }
}

async function copyRuntimeWorkspacePath(relativePath, destination) {
  const source = path.join(runtimeWorkspace, relativePath);
  if (!existsSync(source)) {
    throw new Error(`Missing required Docker manifest path: ${relativePath}`);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: false,
    dereference: false,
  });
}

function shouldCopy(sourcePath) {
  const relativePath = path.relative(repoRoot, sourcePath);
  if (!relativePath) {
    return true;
  }

  const parts = relativePath.split(path.sep);
  if (parts.some((part) => ignoredNames.has(part))) {
    return false;
  }

  return !ignoredFileSuffixes.some((suffix) => relativePath.endsWith(suffix));
}

function assertForbiddenPackagesAbsent() {
  const present = forbiddenPackages.filter((packagePath) =>
    existsSync(path.join(runtimeWorkspace, packagePath)),
  );
  if (present.length > 0) {
    throw new Error(
      `Forbidden package(s) copied into Docker runtime workspace: ${present.join(", ")}`,
    );
  }
}

async function listWorkspacePackages(root) {
  const candidates = [
    ...runtimePackages,
    ...optionalRuntimePackages,
    ...(await listPackageDirs(path.join(root, "rome_apps"), "rome_apps")),
  ];

  const packages = [];
  for (const packagePath of candidates.sort()) {
    const packageJsonPath = path.join(root, packagePath, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packages.push({
      path: packagePath,
      name: packageJson.name ?? null,
    });
  }
  return packages;
}

async function listPackageDirs(root, relativeRoot) {
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(relativeRoot, entry.name))
    .filter((packagePath) => existsSync(path.join(runtimeWorkspace, packagePath, "package.json")));
}

function topLevelPath(relativePath) {
  return relativePath.split("/")[0];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
