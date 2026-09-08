import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { getCoreRoot, getProfileDir, getProfileMemoryDir, getProjectRoot } from "./paths.js";

const GIT_INIT_LOCK_DIR = ".git-init.lock";
const GIT_INIT_POLL_MS = 50;
const GIT_INIT_TIMEOUT_MS = 5_000;

function hasInitializedGitRepo(profileDir: string): boolean {
  return existsSync(join(profileDir, ".git", "HEAD"));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withGitInitLock(profileDir: string, fn: () => void): void {
  const lockDir = join(profileDir, GIT_INIT_LOCK_DIR);
  const deadline = Date.now() + GIT_INIT_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      if (hasInitializedGitRepo(profileDir)) {
        return;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for git initialization in ${profileDir}`);
      }

      sleepSync(GIT_INIT_POLL_MS);
    }
  }

  try {
    fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function copyMissingRecursive(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });

  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyMissingRecursive(sourcePath, destPath);
      continue;
    }

    if (!existsSync(destPath)) {
      copyFileSync(sourcePath, destPath);
    }
  }
}

export function getMemoryTemplateDir(): string {
  // The template ships inside the core package during development and is copied
  // into `dist/` by the Docker bundler (scripts/bundle-docker-core.mjs). Resolve
  // it relative to the core root, not the monorepo root — a wrong root silently
  // skips seeding, leaving fresh profiles without MEMORY.md. Mirror
  // getAppTemplateDir()'s dev-vs-bundled lookup so seeding works in both layouts.
  const candidates = [
    join(getCoreRoot(), "memory.example"),
    join(getCoreRoot(), "dist", "memory.example"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Neither layout was found; return the dev path so the caller's existsSync
  // guard reports a sensible missing location.
  return candidates[0];
}

/**
 * Initialize the git repo that versions memory — at the **memory dir**, not the
 * profile root. Memory is its own self-contained repo so it can be
 * synced to GitHub as a unit; `git add -A` then stages exactly memory and never
 * the profile's database, credentials, projects, or apps that sit alongside it.
 * No `.gitignore` is needed — the memory tree holds only markdown + assets.
 */
function ensureMemoryGitInitialized(memoryDir: string): void {
  if (hasInitializedGitRepo(memoryDir)) return;
  withGitInitLock(memoryDir, () => {
    if (!hasInitializedGitRepo(memoryDir)) {
      execSync("git init", { cwd: memoryDir, stdio: "pipe" });
    }
  });
}

export function ensureProfileMemoryInitialized(): string {
  const profileDir = getProfileDir();
  const profileMemoryDir = getProfileMemoryDir();
  const templateDir = getMemoryTemplateDir();

  mkdirSync(profileDir, { recursive: true });
  mkdirSync(profileMemoryDir, { recursive: true });

  if (existsSync(templateDir) && statSync(templateDir).isDirectory()) {
    copyMissingRecursive(templateDir, profileMemoryDir);
  }

  // Init the repo after the dir (and any seeded template) exist, so commits made
  // on edit/sync land in `memory/.git`.
  ensureMemoryGitInitialized(profileMemoryDir);

  return profileMemoryDir;
}

export function resolveProfileMemoryPath(filePath: string): string {
  if (filePath === "memory" || filePath.startsWith("memory/")) {
    return resolve(getProfileDir(), filePath);
  }

  return resolve(getProjectRoot(), filePath);
}

/**
 * Where every memory profile lives, as the memory file browser addresses it:
 * one folder under the memory root holding one file per person. The template's
 * `relationship/BONDS.md` states the same convention to the agent that writes
 * the profiles.
 *
 * Read it from here rather than spelling it again — a second literal keeps
 * working after this folder moves, and answers about a file nobody writes any
 * more.
 */
export const RELATIONSHIP_DIR = "memory/relationship";

/**
 * The guardian's profile, which is named for the role rather than for their
 * person id: onboarding writes it before there is anything to key it by, and
 * every surface that reads the guardian reads this one name. It is what
 * `persons.profile_path` holds for the guardian row.
 */
export const GUARDIAN_PROFILE_PATH = `${RELATIONSHIP_DIR}/GUARDIAN.md`;

/** How everyone else's profile is named: by the id of the person it is about. */
export function personProfileFileName(personId: string): string {
  return `${personId}.md`;
}

/** The relationship directory on disk, for reading or writing the files in it. */
export function getRelationshipDir(): string {
  return resolveProfileMemoryPath(RELATIONSHIP_DIR);
}

/** The guardian's profile on disk. */
export function getGuardianProfileFile(): string {
  return resolveProfileMemoryPath(GUARDIAN_PROFILE_PATH);
}
