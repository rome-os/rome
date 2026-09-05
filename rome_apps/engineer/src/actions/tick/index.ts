import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AgentRunnerInterface,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import {
  BRANCH_TEMPLATE,
  CHILD_MARKER_TEMPLATE,
  ENGINEER_AGENT,
  READY_LABEL,
  RESUME_MARKER_TEMPLATE,
  STEERING_RESUME_MARKER_TEMPLATE,
  STOPPED_MARKER_TEMPLATE,
  STUCK_LABEL,
  readConfig,
  type EngineerConfig,
} from "../../lib/config.js";

const log = createAppLogger("engineer-tick");

export interface TickDeps {
  agentRunner: AgentRunnerInterface;
}

/**
 * The whole instruction for one reconciliation pass. Every tick gets the same
 * text with the current config spliced in — no tick reads another tick's
 * context, so the prompt has to carry the configuration, the caps, and the
 * marker formats that stand in for cross-tick memory.
 *
 * The step order is load-bearing. A turn that runs out of budget loses its last
 * step, and the only step whose loss corrupts the state is a start whose marker
 * never lands: the issue then has a live child no later tick can see. So starts
 * come first, each paired with its marker write, and the steps that only read
 * and steer follow.
 */
export function buildTickPrompt(config: EngineerConfig, now: Date): string {
  return [
    `Reconciliation tick at ${now.toISOString()}.`,
    "",
    "Configuration for this tick:",
    `- repo: ${config.repo}`,
    `- label: ${config.label}`,
    `- projectPath: ${config.projectPath}`,
    `- maxNewTasksPerTick: ${config.maxNewTasksPerTick}`,
    `- maxActiveChildren: ${config.maxActiveChildren}`,
    `- maxResumesPerIssue: ${config.maxResumesPerIssue}`,
    `- maxChildAgeHours: ${config.maxChildAgeHours}`,
    `- maxIssuesPerTick: ${config.maxIssuesPerTick}`,
    "",
    "Names and marker formats:",
    `- Stuck label: ${STUCK_LABEL}`,
    `- Ready label: ${READY_LABEL}`,
    `- Child branch naming: ${BRANCH_TEMPLATE}`,
    `- Start marker: ${CHILD_MARKER_TEMPLATE}`,
    `- Resume marker: ${RESUME_MARKER_TEMPLATE}`,
    `- Steering resume marker: ${STEERING_RESUME_MARKER_TEMPLATE}`,
    `- Stopped marker: ${STOPPED_MARKER_TEMPLATE}`,
    "",
    "Run the tick procedure from your instructions, once, in this order:",
    `a. Read the state. Open issues labeled ${config.label} with their comments, oldest first, and take at most ${config.maxIssuesPerTick} of them this tick. Open pull requests labeled ${config.label} with number, headRefName, headRefOid, mergeable, statusCheckRollup, reviewDecision and body. For each issue parse its newest start marker, its newest resume marker (both attempt and sha), and any stopped marker. Call system:summon_status on each issue's current child id and hold every answer — do not act on any of them yet.`,
    `b. Start new children, before anything else you do this tick. Among the issues you just read that carry no start marker and no ${STUCK_LABEL} label, oldest first, start at most ${config.maxNewTasksPerTick} this tick, and only while fewer than ${config.maxActiveChildren} children are running. A child whose newest marker is a stopped marker never counts as running. Re-read the issue's comments immediately before each start and skip it if a marker appeared. Start with system:summon { agentName: "coding:coding", prompt: "<the brief>", detached: true, workingDir: "${config.projectPath}" }. The moment summon returns, write that issue's start marker comment, before you start any other child.`,
    `c. Act on the statuses you read in step a. If the newest marker on the issue (start or resume) is older than ${config.maxChildAgeHours} hours and its child is still running or unknown, call system:summon_stop on the session, write the stopped marker with one line saying it ran past ${config.maxChildAgeHours} hours, and leave the issue to the next tick, which reads it as failed. Otherwise: running or unknown, leave it alone. completed, look for the pull request on branch ${BRANCH_TEMPLATE}, and if there is none resume the child with reason no-pr to open one with \`gh pr create\` and \`Closes #<n>\` in the body. failed or interrupted, resume the child with reason failed or interrupted and a prompt naming what went wrong and saying to continue from the branch's current state. not_found, treat the issue as having no child and let the next tick start a fresh one.`,
    `d. Steer every open pull request that closes one of the issues you read. Skip the pull request when its headRefOid equals the sha on that issue's newest steering resume marker — the child has not pushed since your last steer, so the checks have not re-run. If a check failed, the pull request has conflicts, or a review comment is unanswered, resume that issue's child with a follow-up that pastes the failing check names with the relevant log excerpt and the full text of every unanswered comment, and tells it to push to the same branch and reply to each comment it addressed. Record that resume with the steering resume marker, reason ci, conflict, review or no-pr, and sha set to the pull request's headRefOid. If the checks are green, there are no conflicts and nothing is unanswered, put ${READY_LABEL} on the pull request and comment once that it is ready for review. Never merge.`,
    "e. End the turn with a short list of what you did. Do not wait for any child, do not sleep, do not poll.",
    "",
    "Resume rules, for every resume in step c and step d alike:",
    `- Read the highest attempt on the issue's resume markers first. Your resume is that number plus one. If it would be above ${config.maxResumesPerIssue}, do not resume: add the ${STUCK_LABEL} label and comment why, naming the session id and the failing text, then move on.`,
    "- The moment the resume call returns, write the resume marker on the issue with one human line saying what you asked for. A resume you do not mark is a resume the cap cannot count.",
    '- A resume that answers { status: "error", error: "child is still running" } is not a failure. Write no marker, leave the issue, and come back next tick.',
  ].join("\n");
}

export function createTickAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<TickDeps>,
): Action {
  const { agentRunner } = deps;

  return {
    config,
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'GitHub repository as "owner/name".' },
        projectPath: {
          type: "string",
          description: "Absolute path of the clone children work in.",
        },
        label: {
          type: "string",
          description: "Label marking the issues and pull requests to reconcile.",
        },
        maxNewTasksPerTick: {
          type: "number",
          description: "Child coding sessions this tick may start.",
        },
        maxActiveChildren: {
          type: "number",
          description: "Child coding sessions allowed to run at once.",
        },
        maxResumesPerIssue: {
          type: "number",
          description: "Resumes one issue may collect before the tick labels it stuck.",
        },
        maxChildAgeHours: {
          type: "number",
          description: "Hours a child may run before the tick interrupts it.",
        },
        maxIssuesPerTick: {
          type: "number",
          description: "Issues this tick reads and reconciles.",
        },
      },
      required: ["repo", "projectPath"],
    },

    async execute(args): Promise<ActionResult> {
      const parsed = readConfig(args);
      if (!parsed.ok) {
        return { status: "error", error: parsed.error };
      }

      const prompt = buildTickPrompt(parsed.config, new Date());
      log.info("tick started", { repo: parsed.config.repo, label: parsed.config.label });

      let summary = "";
      for await (const msg of agentRunner.run({ agentName: ENGINEER_AGENT, prompt })) {
        if (msg.type === "result") {
          summary = msg.content as string;
        } else if (msg.type === "error") {
          log.error("tick agent failed", { error: msg.error });
          return { status: "error", error: `Engineer tick failed: ${msg.error}` };
        }
      }

      log.info("tick finished", { repo: parsed.config.repo, summaryLength: summary.length });

      return { status: "ok", data: { repo: parsed.config.repo, summary } };
    },
  };
}

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps<TickDeps>): Action {
  return createTickAction(config, deps);
}
