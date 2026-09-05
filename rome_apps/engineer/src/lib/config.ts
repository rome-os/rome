/**
 * The engineer app keeps no table of its own: every fact about a task lives in
 * GitHub, and the handful of settings that are not facts about a task live in
 * the args of the two routines `engineer:setup` registers. Both routine targets
 * (`engineer:tick`, `engineer:daily_report`) therefore receive the whole config
 * on every fire and read it back through {@link readConfig}.
 */

/** Canonical id of the manager agent every action drives. */
export const ENGINEER_AGENT = "engineer:engineer";

/** Stable identities of the two routines `engineer:setup` owns. */
export const TICK_ROUTINE_KEY = "engineer-tick";
export const REPORT_ROUTINE_KEY = "engineer-daily-report";

/** Names the guardian sees for those routines in the dashboard. */
export const TICK_ROUTINE_NAME = "Engineer: reconcile GitHub";
export const REPORT_ROUTINE_NAME = "Engineer: daily report";

/** Name of the chat `engineer:daily_report` posts its report into. */
export const REPORT_SESSION_NAME = "Engineer daily report";

/** Labels the bot applies on top of the guardian-chosen task label. */
export const STUCK_LABEL = "engineer:stuck";
export const READY_LABEL = "engineer:ready";

export const DEFAULT_LABEL = "engineer";
export const DEFAULT_TICK_MINUTES = 30;
export const DEFAULT_REPORT_LOCAL_TIME = "08:00";
export const DEFAULT_MAX_NEW_TASKS_PER_TICK = 1;
export const DEFAULT_MAX_ACTIVE_CHILDREN = 3;
export const DEFAULT_MAX_RESUMES_PER_ISSUE = 3;
export const DEFAULT_MAX_CHILD_AGE_HOURS = 3;
export const DEFAULT_MAX_ISSUES_PER_TICK = 20;

/**
 * The three comments that make up an issue's history with its child coding
 * sessions. They are the app's only cross-tick memory, so a tick writes the
 * matching one the moment the call it records returns.
 *
 * - A start marker claims the issue: it links the issue to the child, and it is
 *   the lock that stops two overlapping ticks from starting the same task
 *   twice.
 * - A resume marker records one steer of that child. `attempt` is what the
 *   resume cap counts, and `sha` — written when the resume answers a pull
 *   request — is the head commit the steer was based on, so a tick that sees
 *   the same head again knows the checks have not re-run yet.
 * - A stopped marker records that the bot interrupted a child that ran past
 *   its age limit. The next tick reads the child as failed.
 */
export const CHILD_MARKER_TEMPLATE = "<!-- engineer child=<sessionId> issue=<n> -->";
export const RESUME_MARKER_TEMPLATE =
  "<!-- engineer resume child=<sessionId> issue=<n> attempt=<k> reason=<failed|interrupted|no-pr|ci|review|conflict> -->";
export const STEERING_RESUME_MARKER_TEMPLATE =
  "<!-- engineer resume child=<sessionId> issue=<n> attempt=<k> reason=<no-pr|ci|review|conflict> sha=<headRefOid> -->";
export const STOPPED_MARKER_TEMPLATE = "<!-- engineer stopped child=<sessionId> issue=<n> -->";

/** Branch a child must work on, so a tick can find the pull request from the issue number alone. */
export const BRANCH_TEMPLATE = "engineer/issue-<n>-<slug>";

export interface EngineerConfig {
  /** GitHub repository as `owner/name`. */
  repo: string;
  /** Label marking the issues and pull requests this bot owns. */
  label: string;
  /** Absolute path of the clone every child coding session works in. */
  projectPath: string;
  tickMinutes: number;
  /** `HH:mm` in the guardian's own timezone; the report routine is floating. */
  reportLocalTime: string;
  /** Child coding sessions a single tick may start. */
  maxNewTasksPerTick: number;
  /** Child coding sessions allowed to be running at once, across ticks. */
  maxActiveChildren: number;
  /** Resumes one issue may collect — start and steering resumes share the count — before it is labeled stuck. */
  maxResumesPerIssue: number;
  /** Hours a child may run before the tick interrupts it and treats the issue as failed. */
  maxChildAgeHours: number;
  /** Issues a single tick reads and reconciles, so the agent's turn budget bounds. */
  maxIssuesPerTick: number;
}

export type ReadConfigResult = { ok: true; config: EngineerConfig } | { ok: false; error: string };

export const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LOCAL_TIME_PATTERN = /^([01]?\d|2[0-3]):[0-5]\d$/;

function positiveInt(value: unknown, fallback: number, max: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Project a routine's `args` onto {@link EngineerConfig}. Rejects only the two
 * fields that have no safe default — the repository and the clone path — and
 * clamps the rest, because a routine fires unattended and a nonsense cap should
 * degrade to the default rather than stop the loop. The routine engine merges
 * its own `__triggerPayload` key into args, so unknown keys are ignored.
 */
export function readConfig(args: Record<string, unknown>): ReadConfigResult {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!REPO_PATTERN.test(repo)) {
    return {
      ok: false,
      error: `repo must be "owner/name"; got ${JSON.stringify(args.repo ?? null)}. Run engineer:setup first.`,
    };
  }

  const projectPath = typeof args.projectPath === "string" ? args.projectPath.trim() : "";
  if (!projectPath.startsWith("/")) {
    return {
      ok: false,
      error: `projectPath must be an absolute path to the clone; got ${JSON.stringify(args.projectPath ?? null)}. Run engineer:setup first.`,
    };
  }

  const label =
    typeof args.label === "string" && args.label.trim() ? args.label.trim() : DEFAULT_LABEL;
  const reportLocalTime =
    typeof args.reportLocalTime === "string" && LOCAL_TIME_PATTERN.test(args.reportLocalTime.trim())
      ? args.reportLocalTime.trim()
      : DEFAULT_REPORT_LOCAL_TIME;

  return {
    ok: true,
    config: {
      repo,
      label,
      projectPath,
      tickMinutes: positiveInt(args.tickMinutes, DEFAULT_TICK_MINUTES, 1440),
      reportLocalTime,
      maxNewTasksPerTick: positiveInt(args.maxNewTasksPerTick, DEFAULT_MAX_NEW_TASKS_PER_TICK, 10),
      maxActiveChildren: positiveInt(args.maxActiveChildren, DEFAULT_MAX_ACTIVE_CHILDREN, 10),
      maxResumesPerIssue: positiveInt(args.maxResumesPerIssue, DEFAULT_MAX_RESUMES_PER_ISSUE, 10),
      maxChildAgeHours: positiveInt(args.maxChildAgeHours, DEFAULT_MAX_CHILD_AGE_HOURS, 168),
      maxIssuesPerTick: positiveInt(args.maxIssuesPerTick, DEFAULT_MAX_ISSUES_PER_TICK, 100),
    },
  };
}

/** The config as a routine `args` object — the app's only persistent storage. */
export function toRoutineArgs(config: EngineerConfig): Record<string, unknown> {
  return { ...config };
}
