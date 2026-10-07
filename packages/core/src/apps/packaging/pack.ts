import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { appIdToPathSegment } from "./app-id.js";
import { readManifestSummary, type ManifestSummary } from "./manifest.js";
import { PACKED_ARTIFACT_SENTINEL } from "./recognition.js";
import { BuildValidationError, validateInstalledArtifact } from "./validate.js";

/**
 * Top-level dirs to drop when snapshotting a workspace without an explicit
 * `appRoot`. `src/` is copied separately when the manifest opts into source
 * publishing.
 */
const SNAPSHOT_EXCLUDED_TOP_LEVEL_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "src",
  ".rome",
  ".rome_store",
  ".turbo",
]);

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/;
const SOURCE_EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  ".git",
  ".rome",
  ".rome_store",
  ".turbo",
  ".next",
  "coverage",
]);
const ALLOWED_ENV_EXAMPLE_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
const PRIVATE_KEY_FILE_PATTERN = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const CREDENTIAL_FILE_NAMES = new Set([
  "credentials.json",
  "service-account.json",
  "service_account.json",
]);

export interface PackOptions {
  /** If set, verify the source manifest's id matches before packing. */
  appId?: string;
  /**
   * When true, remove `outDir` before packing if it exists. Lets callers
   * re-pack into a stable path (e.g. `<source>/.rome/artifact/`) across
   * iterations. Default: false — refuse a non-empty outDir, so the user
   * doesn't lose work to a typo.
   */
  clean?: boolean;
}

export interface PackedArtifact {
  appId: string;
  version: string;
  outDir: string;
}

/**
 * Build a compiled app artifact from a source workspace into `outDir`.
 *
 * Pipeline:
 *   1. Read & validate the source `app.yaml`. If `options.appId` is given,
 *      verify the manifest id matches.
 *   2. Snapshot the workspace into a temp dir under `os.tmpdir()` (honoring
 *      the manifest's `appRoot` field if set; otherwise mirroring the
 *      top-level layout minus `src/`, `dist/`, `node_modules/`, etc.).
 *      Staging outside the source tree means `outDir` can live anywhere —
 *      including under the source tree (e.g. the default
 *      `<source>/.rome/artifact/`) — without the snapshot walk recursing
 *      into its own output.
 *   3. Validate the staged output against the manifest — every referenced
 *      agent, action, skill, hook, web manifest, api entry, and db
 *      migrations dir must exist.
 *   4. Copy the staged output into `outDir`.
 *
 * Pack stops at the "packed artifact" stage of the three-stage model in
 * `docs/architecture/app-artifact.md` — the artifact never ships
 * `node_modules`; runtime deps are installed on the install host at
 * materialize time.
 *
 * `outDir` must not exist, or must be an empty directory. On any failure
 * the temp staging dir is removed; if `outDir` was created by this call
 * it is removed too, so the caller doesn't have to clean up partial state.
 */
export async function packArtifact(
  sourceRoot: string,
  outDir: string,
  options: PackOptions = {},
): Promise<PackedArtifact> {
  const manifestPath = join(sourceRoot, "app.yaml");
  if (!existsSync(manifestPath)) {
    throw new Error(`Pack source ${sourceRoot} is missing app.yaml`);
  }

  const manifest = await readManifestSummary(manifestPath);
  if (options.appId !== undefined && manifest.id !== options.appId) {
    throw new Error(
      `Source manifest id "${manifest.id}" at ${manifestPath} does not match pack target "${options.appId}"`,
    );
  }

  if (options.clean !== true && existsSync(outDir)) {
    const entries = await readdir(outDir);
    if (entries.length > 0) {
      throw new Error(
        `Pack output directory ${outDir} is not empty. Remove it, choose a different --out path, or re-run with --clean.`,
      );
    }
  }

  // `<repo>/.rome/artifact` is the pinned artifact for the currently
  // installed hash, so the previous artifact must survive any pack failure.
  // The replacement is fully assembled in a sibling dir (same filesystem as
  // outDir), then swapped in with two renames — the only window in which the
  // old artifact is not at its path is between those renames, after the new
  // artifact is already complete on disk. Snapshot + validation still run in
  // a tmpdir first, so a source that fails to pack never touches outDir.
  const stagingRoot = await mkdtemp(
    join(tmpdir(), `rome-pack-${appIdToPathSegment(manifest.id)}-`),
  );
  const replacementDir = `${outDir}.packing-${process.pid}`;
  const retiredDir = `${outDir}.retired-${process.pid}`;
  try {
    await snapshotIntoStaging(sourceRoot, stagingRoot, manifest);
    await validateInstalledArtifact(stagingRoot, manifest.id);
    await writeFile(
      join(stagingRoot, PACKED_ARTIFACT_SENTINEL),
      `${JSON.stringify({ appId: manifest.id, version: manifest.version })}\n`,
      "utf-8",
    );
    await rm(replacementDir, { recursive: true, force: true });
    await mkdir(dirname(replacementDir), { recursive: true });
    await cp(stagingRoot, replacementDir, { recursive: true, dereference: true });
    if (existsSync(outDir)) {
      await rm(retiredDir, { recursive: true, force: true });
      await rename(outDir, retiredDir);
      try {
        await rename(replacementDir, outDir);
      } catch (err) {
        await rename(retiredDir, outDir).catch(() => {});
        throw err;
      }
      await rm(retiredDir, { recursive: true, force: true }).catch(() => {});
    } else {
      await rename(replacementDir, outDir);
    }
  } catch (err) {
    await rm(replacementDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }

  return { appId: manifest.id, version: manifest.version, outDir };
}

export interface BuildSourceWorkspaceOptions {
  /**
   * Root of the enclosing Rome checkout. `buildSourceWorkspace` refuses to
   * run pnpm in a source dir inside this tree unless the dir is its own
   * workspace root — see the guard below.
   */
  projectRoot: string;
}

/**
 * Daemon-side build stage for a `mode: "source"` install: run the app
 * workspace's own toolchain (`pnpm install`, then its `build` script) so the
 * subsequent `packArtifact` finds the manifest-declared outputs. Workspaces
 * with no `package.json`, no deps, and no `build` script (pure-YAML apps)
 * need nothing and return immediately.
 *
 * Guard: pnpm resolves the *enclosing* workspace, so running it inside a
 * member of the Rome monorepo (any `rome_apps/*` seed) would mutate the
 * monorepo's own node_modules/store — the exact footgun that crashes a live
 * dev stack. Source-mode builds therefore require the app to be a standalone
 * workspace root (its own `pnpm-workspace.yaml`, which the scaffold template
 * ships) whenever it sits inside `options.projectRoot`.
 */
export async function buildSourceWorkspace(
  sourceRoot: string,
  options: BuildSourceWorkspaceOptions,
): Promise<void> {
  const pkgPath = join(sourceRoot, "package.json");
  if (!existsSync(pkgPath)) return;
  const pkg = await readPackageManifest(sourceRoot);
  const hasBuildScript = typeof pkg.scripts?.build === "string";
  const hasDeps =
    Object.keys(pkg.dependencies ?? {}).length > 0 ||
    Object.keys(pkg.devDependencies ?? {}).length > 0;
  if (!hasBuildScript && !hasDeps) return;

  if (
    !existsSync(join(sourceRoot, "pnpm-workspace.yaml")) &&
    isInside(options.projectRoot, sourceRoot)
  ) {
    throw new BuildValidationError(
      `${sourceRoot} is a workspace member of the Rome monorepo, so the daemon will not run ` +
        `pnpm in it (that would install into the monorepo itself). First-party apps are bundled ` +
        `at build time (\`pnpm build:apps\`) and installed automatically at boot — rebuild and ` +
        `restart Rome to pick up changes; they are not installable through the daemon.`,
    );
  }

  try {
    await runPnpm(["install"], { cwd: sourceRoot });
    if (hasBuildScript) {
      await runPnpm(["run", "build"], { cwd: sourceRoot });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BuildValidationError(
      `App build failed in ${sourceRoot}: ${message}. Reproduce locally with ` +
        `\`pnpm --dir ${sourceRoot} install && pnpm --dir ${sourceRoot} run build\`, fix the ` +
        `error, then re-run install with the same source.`,
    );
  }
}

function isInside(parentDir: string, path: string): boolean {
  const rel = relative(resolve(parentDir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export interface PackageJsonManifest {
  name?: string;
  version?: string;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function readPackageManifest(appRoot: string): Promise<PackageJsonManifest> {
  const filePath = join(appRoot, "package.json");
  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid package.json in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid package.json in ${filePath}`);
  }
  return parsed as PackageJsonManifest;
}

/**
 * Callers hold the app-lifecycle mutex while pnpm runs, so a hung process
 * blocks every other install/uninstall until killed. Cap each invocation so
 * the mutex is guaranteed to release. 5 minutes is well above any realistic
 * app build or `pnpm install --prod` for an app's runtime deps.
 */
const PNPM_TIMEOUT_MS = 5 * 60 * 1000;

// Bounds on the pnpm output a failure carries. The error message lands in the
// lockfile's `lastError` and in telemetry, so it stays small.
const PNPM_OUTPUT_BUFFER_CHARS = 16 * 1024;
const PNPM_OUTPUT_TAIL_LINES = 30;
const PNPM_OUTPUT_TAIL_CHARS = 4000;

// After pnpm exits, how long to wait for its piped output to drain. A
// descendant (a lifecycle script's background process) can inherit the pipes
// and keep them open indefinitely, so completion never waits on them.
const PNPM_OUTPUT_DRAIN_MS = 250;

/**
 * Run pnpm in `cwd`. Output still streams to this process's stdout and stderr.
 * On a non-zero exit or a timeout, the rejection's message ends with the tail
 * of pnpm's combined output, since pnpm prints its `ERR_PNPM_*` diagnostics to
 * stdout and the exit code alone does not say why.
 *
 * Settles on pnpm's own `exit`, not on `close`: `close` also waits for every
 * descendant holding the output pipes, which would defeat the timeout and keep
 * the app-lifecycle mutex held.
 */
export function runPnpm(
  args: string[],
  options: { cwd: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PNPM_TIMEOUT_MS;
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const child = spawn("pnpm", args, {
      cwd: options.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      signal: controller.signal,
    });
    let output = "";
    const streams = [child.stdout, child.stderr].filter(
      (stream): stream is NonNullable<typeof stream> => stream !== null,
    );
    const capture = (sink: NodeJS.WriteStream) => (chunk: string) => {
      sink.write(chunk);
      output = (output + chunk).slice(-PNPM_OUTPUT_BUFFER_CHARS);
    };
    // setEncoding decodes across chunk boundaries, so multi-byte characters
    // split between two chunks survive.
    child.stdout?.setEncoding("utf8").on("data", capture(process.stdout));
    child.stderr?.setEncoding("utf8").on("data", capture(process.stderr));

    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };

    child.once("exit", (code) => {
      // Decide the outcome at exit time, so an abort that fires while the
      // output drains cannot turn a clean exit into a timeout.
      const timedOut = controller.signal.aborted;
      const command = `pnpm ${args.join(" ")}`;
      const finish = () =>
        settle(() => {
          for (const stream of streams) stream.destroy();
          if (timedOut) {
            rejectPromise(
              new Error(
                `Command timed out after ${timeoutMs}ms: ${command} (cwd: ${options.cwd})` +
                  formatOutputTail(output),
              ),
            );
            return;
          }
          if (code === 0) {
            resolvePromise();
            return;
          }
          rejectPromise(
            new Error(
              `Command failed: ${command} (cwd: ${options.cwd}, exit ${code ?? "null"})` +
                formatOutputTail(output),
            ),
          );
        });
      const drainTimer = setTimeout(finish, PNPM_OUTPUT_DRAIN_MS);
      let open = streams.filter((stream) => !stream.readableEnded).length;
      if (open === 0) {
        clearTimeout(drainTimer);
        finish();
        return;
      }
      for (const stream of streams) {
        if (stream.readableEnded) continue;
        stream.once("end", () => {
          open -= 1;
          if (open === 0) {
            clearTimeout(drainTimer);
            finish();
          }
        });
      }
    });
    child.once("error", (err) => {
      if (controller.signal.aborted) return;
      settle(() => rejectPromise(err));
    });
  });
}

function formatOutputTail(output: string): string {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const tail = lines.slice(-PNPM_OUTPUT_TAIL_LINES).join("\n").slice(-PNPM_OUTPUT_TAIL_CHARS);
  return `\npnpm output (tail):\n${tail}`;
}

/**
 * Snapshot a workspace directory into the staging dir for a packed
 * artifact. Layout depends on whether the manifest declares `appRoot`:
 *   - `appRoot: dist` → copy `app.yaml`, package metadata/config, and the
 *     `dist/` subtree. `src/`, `tsconfig.json`, etc. are left out.
 *   - no `appRoot` → copy every top-level entry except `src/`, `dist/`,
 *     `node_modules/`, `.git/`, drizzle config, and tests/declarations.
 */
async function snapshotIntoStaging(
  workspaceRoot: string,
  stagingRoot: string,
  manifest: ManifestSummary,
): Promise<void> {
  await mkdir(stagingRoot, { recursive: true });

  await copyIfExists(workspaceRoot, stagingRoot, "app.yaml");
  await copyIfExists(workspaceRoot, stagingRoot, "package.json");
  await copyIfExists(workspaceRoot, stagingRoot, "pnpm-workspace.yaml");
  await copyIfExists(workspaceRoot, stagingRoot, "pnpm-lock.yaml");
  await copyIfExists(workspaceRoot, stagingRoot, "README.md");
  await copyPublishedSource(workspaceRoot, stagingRoot, manifest);

  if (manifest.appRoot) {
    const appRootDir = join(workspaceRoot, manifest.appRoot);
    if (!existsSync(appRootDir)) {
      throw new BuildValidationError(
        `Manifest declares appRoot "${manifest.appRoot}" but ${appRootDir} does not exist. ` +
          `Run the app's build step before installing (e.g. \`pnpm --dir ${workspaceRoot} run build\`).`,
      );
    }
    await cp(appRootDir, join(stagingRoot, manifest.appRoot), {
      recursive: true,
      dereference: true,
      filter: makeArtifactFilter(appRootDir),
    });
    if (manifest.iconPath) {
      await copyIconIfOutsideAppRoot(workspaceRoot, stagingRoot, manifest);
    }
    return;
  }

  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "app.yaml" || entry.name === "package.json") continue;
    if (entry.name === "pnpm-workspace.yaml") continue;
    if (entry.name === "pnpm-lock.yaml") continue;
    if (entry.name === "README.md") continue;
    if (entry.isDirectory()) {
      if (SNAPSHOT_EXCLUDED_TOP_LEVEL_DIRS.has(entry.name)) continue;
      await cp(join(workspaceRoot, entry.name), join(stagingRoot, entry.name), {
        recursive: true,
        dereference: true,
        filter: makeArtifactFilter(workspaceRoot),
      });
      continue;
    }
    if (entry.isFile()) {
      if (
        entry.name === "tsconfig.json" ||
        entry.name === "tsconfig.app.json" ||
        entry.name.startsWith("drizzle.config.") ||
        entry.name === "components.json" ||
        TEST_FILE_PATTERN.test(entry.name) ||
        DECLARATION_FILE_PATTERN.test(entry.name)
      ) {
        continue;
      }
      await cp(join(workspaceRoot, entry.name), join(stagingRoot, entry.name), {
        dereference: true,
      });
    }
  }
}

async function copyPublishedSource(
  workspaceRoot: string,
  stagingRoot: string,
  manifest: ManifestSummary,
): Promise<void> {
  if (!manifest.includeSource) return;

  const sourceDir = join(workspaceRoot, "src");
  let sourceStat;
  try {
    sourceStat = await lstat(sourceDir);
  } catch {
    throw new BuildValidationError(
      `Manifest declares includeSource: true but ${sourceDir} does not exist.`,
    );
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new BuildValidationError(
      `Manifest declares includeSource: true but ${sourceDir} is not a regular directory.`,
    );
  }

  await validatePublishedSourceTree(sourceDir, sourceDir);
  await cp(sourceDir, join(stagingRoot, "src"), {
    recursive: true,
    dereference: false,
    filter: makeSourceFilter(sourceDir),
  });
}

async function validatePublishedSourceTree(sourceRoot: string, currentDir: string): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (isExcludedSourceEntry(entry.name)) continue;

    const absolutePath = join(currentDir, entry.name);
    const relativePath = relative(sourceRoot, absolutePath);
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      throw new BuildValidationError(
        `Cannot publish source file ${relativePath}: symbolic links are not allowed in src/.`,
      );
    }
    if (stat.isDirectory()) {
      await validatePublishedSourceTree(sourceRoot, absolutePath);
      continue;
    }
    if (!stat.isFile() || stat.nlink > 1) {
      throw new BuildValidationError(
        `Cannot publish source file ${relativePath}: only regular, non-linked files are allowed in src/.`,
      );
    }
    if (isBlockedSourceFile(entry.name)) {
      throw new BuildValidationError(
        `Cannot publish source file ${relativePath}: secret files are not allowed in src/.`,
      );
    }
  }
}

function makeSourceFilter(sourceRoot: string): (sourcePath: string) => boolean {
  return (sourcePath: string) => {
    const rel = relative(sourceRoot, sourcePath);
    if (rel === "") return true;
    const segments = rel.split(sep);
    if (segments.some((segment) => SOURCE_EXCLUDED_SEGMENTS.has(segment))) return false;
    return segments[segments.length - 1] !== ".DS_Store";
  };
}

export function isExcludedSourceEntry(name: string): boolean {
  return SOURCE_EXCLUDED_SEGMENTS.has(name) || name === ".DS_Store";
}

export function isBlockedSourceFile(fileName: string): boolean {
  const normalizedFileName = fileName.toLowerCase();
  if (normalizedFileName === ".env") return true;
  if (
    normalizedFileName.startsWith(".env.") &&
    !ALLOWED_ENV_EXAMPLE_FILES.has(normalizedFileName)
  ) {
    return true;
  }
  return PRIVATE_KEY_FILE_PATTERN.test(fileName) || CREDENTIAL_FILE_NAMES.has(normalizedFileName);
}

function makeArtifactFilter(baseDir: string): (sourcePath: string) => boolean {
  return (sourcePath: string) => {
    const rel = relative(baseDir, sourcePath);
    if (rel === "") return true;
    const segments = rel.split(sep);
    if (segments.includes("node_modules")) return false;
    if (segments.includes(".git")) return false;
    if (segments.includes(".rome_store")) return false;
    const fileName = segments[segments.length - 1] ?? "";
    if (TEST_FILE_PATTERN.test(fileName)) return false;
    if (DECLARATION_FILE_PATTERN.test(fileName)) return false;
    return true;
  };
}

async function copyIfExists(src: string, dst: string, fileName: string): Promise<void> {
  const sourcePath = join(src, fileName);
  if (!existsSync(sourcePath)) return;
  await cp(sourcePath, join(dst, fileName), { dereference: true });
}

async function copyIconIfOutsideAppRoot(
  workspaceRoot: string,
  stagingRoot: string,
  manifest: ManifestSummary,
): Promise<void> {
  if (!manifest.iconPath || !manifest.appRoot) return;
  const iconSourceFromAppRoot = join(workspaceRoot, manifest.appRoot, manifest.iconPath);
  if (existsSync(iconSourceFromAppRoot)) return;
  const iconSourceTopLevel = join(workspaceRoot, manifest.iconPath);
  if (!existsSync(iconSourceTopLevel)) return;
  const targetPath = join(stagingRoot, manifest.iconPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(iconSourceTopLevel, targetPath, { dereference: true });
}
