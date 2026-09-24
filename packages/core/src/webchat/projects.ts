import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getProjectsRoot } from "../paths.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "./constants.js";

export interface WebchatProjectOption {
  archivedAt?: string | null;
  createdAt?: string;
  displayName?: string;
  id?: string;
  name: string;
  path: string;
  projectPath?: string;
  updatedAt?: string;
}

export interface WebchatProjectCatalog {
  rootPath: string;
  defaultPath: string;
  projects: WebchatProjectOption[];
}

export interface StoredWebchatProjectLike {
  archivedAt?: Date | null;
  createdAt?: Date;
  id: string;
  name: string;
  path: string;
  updatedAt?: Date;
}

export function getWebchatProjectsRoot(): string {
  return getProjectsRoot();
}

async function ensureDefaultWebchatProject(
  rootPath: string = getWebchatProjectsRoot(),
): Promise<string> {
  await mkdir(rootPath, { recursive: true });
  const defaultPath = resolveWebchatProjectPath(DEFAULT_WEBCHAT_PROJECT_NAME, rootPath);
  await mkdir(defaultPath, { recursive: true });
  return defaultPath;
}

function formatTimestamp(value?: Date): string | undefined {
  return value ? value.toISOString() : undefined;
}

function formatNullableTimestamp(value?: Date | null): string | null | undefined {
  if (value === null) return null;
  return value ? value.toISOString() : undefined;
}

export function normalizeWebchatProjectPath(projectPath: string): string {
  const name = projectPath.trim();

  if (!name) {
    throw new Error("Project path is required");
  }

  if (/[\0-\x1f]/.test(name)) {
    throw new Error("Project path contains unsupported characters");
  }

  if (name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error("Project path must be a relative folder path");
  }

  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Project path must not contain empty, current, or parent segments");
  }

  return segments.join("/");
}

export function getWebchatProjectDisplayName(projectPath: string): string {
  return basename(normalizeWebchatProjectPath(projectPath));
}

export function resolveWebchatProjectPath(
  projectPath: string,
  rootPath: string = getWebchatProjectsRoot(),
): string {
  return join(rootPath, normalizeWebchatProjectPath(projectPath));
}

function isStrictSubpath(fromRoot: string): boolean {
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

/**
 * Resolve a caller-supplied project directory to an absolute working dir inside
 * the projects root. Accepts a path relative to the root (`landingpage/content`)
 * or an absolute path inside it. Throws when the path is the root itself, falls
 * outside it (including through a symlink), or is not an existing directory.
 * Never creates the directory.
 */
export async function resolveProjectWorkingDirWithinRoot(
  requestedPath: string,
  rootPath: string = getWebchatProjectsRoot(),
): Promise<string> {
  const trimmed = requestedPath.trim();
  let projectPath = trimmed;
  if (isAbsolute(trimmed)) {
    const fromRoot = relative(resolve(rootPath), resolve(trimmed));
    if (!isStrictSubpath(fromRoot)) {
      throw new Error(`Working directory "${requestedPath}" is not inside the projects root`);
    }
    projectPath = fromRoot.split(sep).join("/");
  }
  const workingDir = resolveWebchatProjectPath(projectPath, rootPath);

  let realWorkingDir: string;
  let realRoot: string;
  try {
    [realWorkingDir, realRoot] = await Promise.all([realpath(workingDir), realpath(rootPath)]);
  } catch {
    throw new Error(`Working directory "${requestedPath}" does not exist`);
  }
  if (!isStrictSubpath(relative(realRoot, realWorkingDir))) {
    throw new Error(`Working directory "${requestedPath}" is not inside the projects root`);
  }
  if (!(await stat(realWorkingDir)).isDirectory()) {
    throw new Error(`Working directory "${requestedPath}" is not a directory`);
  }
  return workingDir;
}

export async function ensureWebchatProjectWorkspace(
  projectPath: string,
  rootPath: string = getWebchatProjectsRoot(),
): Promise<string> {
  await mkdir(rootPath, { recursive: true });
  const path = resolveWebchatProjectPath(projectPath, rootPath);
  await mkdir(path, { recursive: true });
  return path;
}

export function toWebchatProjectOption(
  project: StoredWebchatProjectLike,
  rootPath: string = getWebchatProjectsRoot(),
): WebchatProjectOption {
  const normalizedPath = normalizeWebchatProjectPath(project.path);
  return {
    id: project.id,
    name: normalizedPath,
    displayName: project.name,
    projectPath: normalizedPath,
    path: resolveWebchatProjectPath(normalizedPath, rootPath),
    createdAt: formatTimestamp(project.createdAt),
    updatedAt: formatTimestamp(project.updatedAt),
    archivedAt: formatNullableTimestamp(project.archivedAt),
  };
}

export function toWebchatProjectCatalog(
  projects: StoredWebchatProjectLike[],
  rootPath: string = getWebchatProjectsRoot(),
): WebchatProjectCatalog {
  return {
    rootPath,
    defaultPath: resolveWebchatProjectPath(DEFAULT_WEBCHAT_PROJECT_NAME, rootPath),
    projects: projects.map((project) => toWebchatProjectOption(project, rootPath)),
  };
}

export function getWebchatProjectPath(
  projectName: string,
  rootPath: string = getWebchatProjectsRoot(),
): string {
  return resolveWebchatProjectPath(projectName, rootPath);
}

export function normalizeSelectedWebchatProjectPath(projectPath?: string | null): string {
  const trimmed = typeof projectPath === "string" ? projectPath.trim() : "";
  return trimmed ? normalizeWebchatProjectPath(trimmed) : DEFAULT_WEBCHAT_PROJECT_NAME;
}

export async function listWebchatProjects(
  rootPath: string = getWebchatProjectsRoot(),
): Promise<WebchatProjectCatalog> {
  const defaultPath = await ensureDefaultWebchatProject(rootPath);

  const entries = await readdir(rootPath, { withFileTypes: true });
  const projects = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(rootPath, entry.name),
    }))
    .sort((a, b) => {
      if (a.name === DEFAULT_WEBCHAT_PROJECT_NAME) {
        return -1;
      }
      if (b.name === DEFAULT_WEBCHAT_PROJECT_NAME) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

  return {
    rootPath,
    defaultPath,
    projects,
  };
}

export async function createWebchatProject(
  projectName: string,
  rootPath: string = getWebchatProjectsRoot(),
): Promise<WebchatProjectOption> {
  await ensureDefaultWebchatProject(rootPath);

  const normalizedName = normalizeWebchatProjectPath(projectName);
  const path = resolveWebchatProjectPath(normalizedName, rootPath);

  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Project "${normalizedName}" already exists`);
    }
    throw error;
  }

  return {
    name: normalizedName,
    path,
  };
}

export async function ensureWebchatProjectExists(
  projectName: string,
  rootPath: string = getWebchatProjectsRoot(),
): Promise<string> {
  const path = resolveWebchatProjectPath(projectName, rootPath);
  const info = await stat(path).catch(() => null);

  if (!info?.isDirectory()) {
    throw new Error(`Selected project "${projectName}" is unavailable`);
  }

  return path;
}

export async function resolveWebchatWorkingDir(
  projectName: string,
  rootPath: string = getWebchatProjectsRoot(),
): Promise<string> {
  await ensureDefaultWebchatProject(rootPath);
  return ensureWebchatProjectExists(projectName, rootPath);
}

/** Just the project fields a continuation needs off a stored webchat session. */
interface WebchatSessionProjectRef {
  projectPath?: string | null;
  projectName?: string | null;
}

/**
 * Resolve the absolute working dir for a *system-initiated continuation* — a
 * deferred `resume_session`, an approval resume, a timer — so the Claude Agent
 * SDK finds the per-cwd transcript (`~/.claude/projects/<enc-cwd>/<id>.jsonl`)
 * in the same project the conversation started in. This mirrors what the inbound
 * webchat route already does (resolve the session's project → its workspace dir);
 * the continuation paths skip that route, so they must re-derive the dir here or
 * fall back to the default project and look for the transcript in the wrong place.
 *
 * Returns `undefined` for non-webchat channels (messaging has no project concept,
 * so the default working dir is correct) and for unknown threads — letting the
 * caller keep its existing default-dir fallback.
 *
 * Unlike the inbound route this only *resolves* the path — it does not `mkdir`.
 * A continuation always targets an existing session, whose project dir was
 * created on its first (inbound) turn; if it were somehow gone there'd be no
 * transcript to resume anyway, so creating an empty dir buys nothing. That keeps
 * this off the filesystem (just the one primary-key `getSession` read).
 */
export async function resolveWebchatContinuationWorkingDir(
  channel: string,
  threadId: string,
  webchatRepo: { getSession(id: string): Promise<WebchatSessionProjectRef | null> },
  rootPath: string = getWebchatProjectsRoot(),
): Promise<string | undefined> {
  if (channel !== "webchat" || !threadId) return undefined;
  const session = await webchatRepo.getSession(threadId);
  if (!session) return undefined;
  const projectPath = normalizeSelectedWebchatProjectPath(
    session.projectPath ?? session.projectName,
  );
  return resolveWebchatProjectPath(projectPath, rootPath);
}
