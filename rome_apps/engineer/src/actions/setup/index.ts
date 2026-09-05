import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AppActionRuntimeDeps,
  type RomeAppContext,
  type Routine,
} from "@rome-os/app-runtime";
import {
  DEFAULT_LABEL,
  DEFAULT_MAX_ACTIVE_CHILDREN,
  DEFAULT_MAX_CHILD_AGE_HOURS,
  DEFAULT_MAX_ISSUES_PER_TICK,
  DEFAULT_MAX_NEW_TASKS_PER_TICK,
  DEFAULT_MAX_RESUMES_PER_ISSUE,
  DEFAULT_REPORT_LOCAL_TIME,
  DEFAULT_TICK_MINUTES,
  READY_LABEL,
  REPO_PATTERN,
  REPORT_ROUTINE_KEY,
  REPORT_ROUTINE_NAME,
  STUCK_LABEL,
  TICK_ROUTINE_KEY,
  TICK_ROUTINE_NAME,
  toRoutineArgs,
  type EngineerConfig,
} from "../../lib/config.js";
import { dailyTrigger, normalizeTickMinutes, tickTrigger } from "../../lib/interval.js";

const log = createAppLogger("engineer-setup");

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs one program with an argv array — never a shell string, so a repository
 * name can never become shell syntax and no credential can be spliced onto a
 * command line. Resolves for a non-zero exit rather than rejecting; only a
 * missing binary rejects.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

const runCommand: CommandRunner = (command, args, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      { cwd: options?.cwd, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof (error as { code?: unknown }).code !== "number") {
          rejectPromise(error);
          return;
        }
        resolvePromise({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

/**
 * Where the guardian's cloned repositories live. App code cannot import the
 * host's path module, and no runtime dependency carries the value, so the
 * environment contract the host itself reads is the seam: `ROME_PROJECTS_ROOT`,
 * then `ROME_WEBCHAT_PROJECTS_ROOT`, then `~/.rome/<profile>/projects`.
 */
export function resolveProjectsRoot(): string {
  const configured =
    process.env.ROME_PROJECTS_ROOT?.trim() || process.env.ROME_WEBCHAT_PROJECTS_ROOT?.trim();
  if (configured) return configured;
  return join(homedir(), ".rome", process.env.ROME_PROFILE?.trim() || "default", "projects");
}

/**
 * Whether an `origin` remote points at `owner/name` on GitHub. Accepts every
 * form `git remote get-url` reports for the same repository — `https://`,
 * `ssh://`, the `git@host:owner/name` short form, an embedded credential, a
 * trailing `.git` — by keeping only the owner and name at the end of the URL.
 * A path with no host (a local clone of a clone) never matches.
 *
 * originMatchesRepo("git@github.com:acme/widgets.git", "acme/widgets") is true.
 */
export function originMatchesRepo(remoteUrl: string, repo: string): boolean {
  const trimmed = remoteUrl
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  if (!trimmed) return false;
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const withoutCredential = withoutScheme.replace(/^[^/@]*@/, "");
  const path = withoutCredential.replace(/^[^/:]+[:/]/, "");
  return path.toLowerCase() === repo.toLowerCase();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Test seams. The runtime calls {@link createAction}, which supplies the real ones. */
export interface SetupSeams {
  run?: CommandRunner;
  directoryExists?: (path: string) => Promise<boolean>;
  ensureParentDir?: (path: string) => Promise<void>;
  projectsRoot?: () => string;
}

class SetupError extends Error {}

interface RoutineSpec {
  key: string;
  name: string;
  actionName: string;
  trigger: Record<string, unknown>;
  args: Record<string, unknown>;
}

/** Outcome of one {@link ensureRoutine} call, reported back to the guardian. */
export type RoutineOutcome = "created" | "replaced" | "unchanged";

/** Value equality over JSON-shaped data, insensitive to key order. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (typeof a !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && jsonEqual(left[key], right[key]));
}

function matchesSpec(routine: Routine, spec: RoutineSpec): boolean {
  return (
    routine.actionName === spec.actionName &&
    jsonEqual(routine.trigger, spec.trigger) &&
    jsonEqual(routine.args, spec.args)
  );
}

/** The key the replacement is parked under while the old routine is deleted. */
function stagingKeyFor(key: string): string {
  return `${key}-staging`;
}

async function createRoutine(
  appContext: RomeAppContext,
  spec: RoutineSpec,
  key: string,
  name: string,
): Promise<string> {
  // create_routine reports caller-fixable problems as { status: "error" } rather
  // than throwing, so a bad trigger would otherwise look like a live routine.
  const created = await appContext.runAction("system:create_routine", {
    name,
    key,
    trigger: spec.trigger,
    actionName: spec.actionName,
    args: spec.args,
  });
  if (created.status !== "ok") {
    const detail =
      created.status === "error" ? created.error : `create_routine returned ${created.status}`;
    throw new SetupError(`could not create routine "${name}": ${detail}`);
  }
  const routineId = (created.data as { routineId?: unknown } | undefined)?.routineId;
  if (typeof routineId !== "string" || !routineId) {
    throw new SetupError(`create_routine returned no routine id for "${name}"`);
  }
  return routineId;
}

/** Deletes one routine. Returns the refusal message, or null once it is gone. */
async function deleteRoutine(
  appContext: RomeAppContext,
  routineId: string,
): Promise<string | null> {
  const deleted = await appContext.runAction("system:delete_routine", { routineId });
  if (deleted.status === "error") return deleted.error;
  if (deleted.status !== "ok") return `delete_routine returned ${deleted.status}`;
  return null;
}

/**
 * Bring one app-owned routine to the given spec, without ever leaving the app
 * with no routine on that schedule.
 *
 * The platform has no update call and refuses a key that is taken, so changing
 * a routine means deleting and creating one. Deleting first is what loses the
 * schedule: `system:delete_routine` refuses a routine that has an active run,
 * which is exactly the state a tick that is running right now puts it in, and
 * the create that was meant to follow never happens. So the replacement is
 * created first, under a staging key, and the old routine is deleted only after
 * that succeeds. Every exit from here has at least one live routine for the
 * spec: the old one when the swap is refused, the staged one when the final
 * create fails, the real one when the swap completes.
 *
 * A swap interrupted between two calls leaves the staged routine behind. The
 * next run deletes it, and the caller sees the same outcome as an uninterrupted
 * run.
 */
async function ensureRoutine(
  appContext: RomeAppContext,
  spec: RoutineSpec,
): Promise<RoutineOutcome> {
  const routines = await appContext.listRoutines();
  const existing = routines.find((routine) => routine.key === spec.key);
  const stagingKey = stagingKeyFor(spec.key);
  const stagingName = `${spec.name} (staging)`;
  const staged = routines.find((routine) => routine.key === stagingKey);

  const dropStaged = async (routineId: string): Promise<void> => {
    const error = await deleteRoutine(appContext, routineId);
    if (error) {
      log.warn("staged routine left behind", { key: stagingKey, routineId, error });
    }
  };

  if (existing && matchesSpec(existing, spec)) {
    if (staged) await dropStaged(staged.id);
    return "unchanged";
  }

  if (!existing) {
    await createRoutine(appContext, spec, spec.key, spec.name);
    if (staged) await dropStaged(staged.id);
    return "created";
  }

  // The staging key has to be free before the replacement can take it, and the
  // routine holding it is a duplicate of the one being replaced anyway.
  if (staged) {
    const stale = await deleteRoutine(appContext, staged.id);
    if (stale) {
      throw new SetupError(`could not replace routine "${spec.name}": ${stale}`);
    }
  }

  const stagingId = await createRoutine(appContext, spec, stagingKey, stagingName);

  const refusal = await deleteRoutine(appContext, existing.id);
  if (refusal) {
    await dropStaged(stagingId);
    throw new SetupError(`could not replace routine "${spec.name}": ${refusal}`);
  }

  try {
    await createRoutine(appContext, spec, spec.key, spec.name);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SetupError(
      `${detail}. The staged routine "${stagingName}" (id ${stagingId}) keeps the schedule ` +
        "running — re-run engineer:setup to finish the swap.",
    );
  }

  await dropStaged(stagingId);
  return "replaced";
}

export function createSetupAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps,
  seams: SetupSeams = {},
): Action {
  const { appContext } = deps;
  const run = seams.run ?? runCommand;
  const dirExists = seams.directoryExists ?? directoryExists;
  const ensureParentDir =
    seams.ensureParentDir ??
    (async (path: string) => void (await mkdir(dirname(path), { recursive: true })));
  const projectsRoot = seams.projectsRoot ?? resolveProjectsRoot;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: 'GitHub repository as "owner/name" — the only repository the bot works on.',
        },
        label: {
          type: "string",
          description: `Label marking the issues and pull requests the bot owns (default "${DEFAULT_LABEL}").`,
        },
        projectPath: {
          type: "string",
          description:
            "Absolute path of an existing clone to work in. Omit to clone the repository under the projects root.",
        },
        tickMinutes: {
          type: "number",
          description: `Minutes between reconciliation passes (default ${DEFAULT_TICK_MINUTES}).`,
        },
        reportLocalTime: {
          type: "string",
          description: `Local time of the daily report as "HH:mm" (default "${DEFAULT_REPORT_LOCAL_TIME}").`,
        },
        maxNewTasksPerTick: {
          type: "number",
          description: `Child coding sessions a single tick may start (default ${DEFAULT_MAX_NEW_TASKS_PER_TICK}).`,
        },
        maxActiveChildren: {
          type: "number",
          description: `Child coding sessions allowed to run at once (default ${DEFAULT_MAX_ACTIVE_CHILDREN}).`,
        },
        maxResumesPerIssue: {
          type: "number",
          description: `Resumes one issue may collect before it is labeled ${STUCK_LABEL} (default ${DEFAULT_MAX_RESUMES_PER_ISSUE}).`,
        },
        maxChildAgeHours: {
          type: "number",
          description: `Hours a child coding session may run before a tick interrupts it (default ${DEFAULT_MAX_CHILD_AGE_HOURS}).`,
        },
        maxIssuesPerTick: {
          type: "number",
          description: `Issues a single tick reads and reconciles (default ${DEFAULT_MAX_ISSUES_PER_TICK}).`,
        },
      },
      required: ["repo"],
    },

    async execute(args): Promise<ActionResult> {
      const repo = typeof args.repo === "string" ? args.repo.trim() : "";
      if (!REPO_PATTERN.test(repo)) {
        return {
          status: "error",
          error: `repo must be "owner/name"; got ${JSON.stringify(args.repo ?? null)}.`,
        };
      }

      const label =
        typeof args.label === "string" && args.label.trim() ? args.label.trim() : DEFAULT_LABEL;

      const requestedPath = typeof args.projectPath === "string" ? args.projectPath.trim() : "";
      if (requestedPath && !isAbsolute(requestedPath)) {
        return { status: "error", error: `projectPath must be absolute; got "${requestedPath}".` };
      }
      // The owner is part of the directory name: two owners publish repositories
      // of the same name, and the second one would otherwise land on the first.
      const [repoOwner, repoName] = repo.split("/");
      const projectPath = requestedPath || join(projectsRoot(), `${repoOwner}-${repoName}`);

      const positive = (value: unknown, fallback: number): number =>
        Math.max(1, Math.round(Number(value)) || fallback);

      const effective: EngineerConfig = {
        repo,
        label,
        projectPath,
        tickMinutes: normalizeTickMinutes(args.tickMinutes, DEFAULT_TICK_MINUTES),
        reportLocalTime:
          typeof args.reportLocalTime === "string" && args.reportLocalTime.trim()
            ? args.reportLocalTime.trim()
            : DEFAULT_REPORT_LOCAL_TIME,
        maxNewTasksPerTick: positive(args.maxNewTasksPerTick, DEFAULT_MAX_NEW_TASKS_PER_TICK),
        maxActiveChildren: positive(args.maxActiveChildren, DEFAULT_MAX_ACTIVE_CHILDREN),
        maxResumesPerIssue: positive(args.maxResumesPerIssue, DEFAULT_MAX_RESUMES_PER_ISSUE),
        maxChildAgeHours: positive(args.maxChildAgeHours, DEFAULT_MAX_CHILD_AGE_HOURS),
        maxIssuesPerTick: positive(args.maxIssuesPerTick, DEFAULT_MAX_ISSUES_PER_TICK),
      };

      const auth = await run("gh", ["auth", "status"]);
      if (auth.code !== 0) {
        return {
          status: "error",
          error:
            "GitHub is not connected. Ask the guardian to connect GitHub at /settings, then run setup again. " +
            `gh reported: ${(auth.stderr || auth.stdout).trim()}`,
        };
      }

      let cloned = false;
      if (await dirExists(projectPath)) {
        // Reusing a directory that holds a different repository would point
        // every child coding session at the wrong code, so the origin remote
        // has to name this repository before the path is accepted.
        const origin = await run("git", ["-C", projectPath, "remote", "get-url", "origin"]);
        if (origin.code !== 0) {
          return {
            status: "error",
            error:
              `${projectPath} already exists and is not a git clone with an origin remote: ` +
              `${(origin.stderr || origin.stdout).trim()}. Pass a projectPath that is a clone of ${repo}, or an empty path to clone into.`,
          };
        }
        if (!originMatchesRepo(origin.stdout, repo)) {
          return {
            status: "error",
            error: `${projectPath} is a clone of ${origin.stdout.trim()}, not of ${repo}. Pass a different projectPath.`,
          };
        }
      } else {
        await ensureParentDir(projectPath);
        const clone = await run("git", ["clone", `https://github.com/${repo}`, projectPath]);
        if (clone.code !== 0) {
          return {
            status: "error",
            error: `git clone of ${repo} into ${projectPath} failed: ${(clone.stderr || clone.stdout).trim()}`,
          };
        }
        cloned = true;
      }

      // --force turns "already exists" into an update, so setup is re-runnable.
      // engineer:stuck and engineer:ready have to exist too: `gh pr edit
      // --add-label` fails on a label the repository does not carry.
      const labels: Array<[string, string, string]> = [
        [label, "0E8A16", "Tasks the Engineer bot owns"],
        [STUCK_LABEL, "B60205", "Engineer could not move this forward"],
        [
          READY_LABEL,
          "1D76DB",
          "Checks green and review answered — ready for the guardian to merge",
        ],
      ];
      for (const [name, color, description] of labels) {
        const result = await run("gh", [
          "label",
          "create",
          name,
          "--repo",
          repo,
          "--force",
          "--color",
          color,
          "--description",
          description,
        ]);
        if (result.code !== 0) {
          return {
            status: "error",
            error: `could not create label "${name}" on ${repo}: ${(result.stderr || result.stdout).trim()}`,
          };
        }
      }

      const routineArgs = toRoutineArgs(effective);
      let routines: Record<string, RoutineOutcome>;
      try {
        routines = {
          [TICK_ROUTINE_KEY]: await ensureRoutine(appContext, {
            key: TICK_ROUTINE_KEY,
            name: TICK_ROUTINE_NAME,
            actionName: "engineer:tick",
            trigger: { ...tickTrigger(effective.tickMinutes) },
            args: routineArgs,
          }),
          [REPORT_ROUTINE_KEY]: await ensureRoutine(appContext, {
            key: REPORT_ROUTINE_KEY,
            name: REPORT_ROUTINE_NAME,
            actionName: "engineer:daily_report",
            trigger: { ...dailyTrigger(effective.reportLocalTime) },
            args: routineArgs,
          }),
        };
      } catch (err) {
        return {
          status: "error",
          error:
            err instanceof SetupError ? err.message : `routine registration failed: ${String(err)}`,
        };
      }

      log.info("engineer configured", { repo, label, projectPath, cloned });

      return { status: "ok", data: { ...effective, cloned, routines } };
    },
  };
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return createSetupAction(config, deps);
}
