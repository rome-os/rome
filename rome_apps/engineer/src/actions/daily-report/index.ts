import {
  createAppLogger,
  type Action,
  type ActionConfig,
  type ActionResult,
  type AgentRunnerInterface,
  type AppActionRuntimeDeps,
  type RomeAppContext,
} from "@rome-os/app-runtime";
import {
  CHILD_MARKER_TEMPLATE,
  ENGINEER_AGENT,
  READY_LABEL,
  REPORT_SESSION_NAME,
  STOPPED_MARKER_TEMPLATE,
  STUCK_LABEL,
  readConfig,
  type EngineerConfig,
} from "../../lib/config.js";

const log = createAppLogger("engineer-daily-report");

export interface DailyReportDeps {
  agentRunner: AgentRunnerInterface;
}

/**
 * The report reads GitHub and nothing else. A tick that failed before it wrote
 * anything to GitHub therefore does not appear in it: an app can list its own
 * routines through `RomeAppContext.listRoutines`, but no surface exposes their
 * runs, so the count of failed ticks is not available to this action. The
 * closest GitHub-visible signals are step 5 below — issues that went stuck and
 * children the bot stopped.
 */
export function buildReportPrompt(config: EngineerConfig, now: Date): string {
  return [
    `Daily report at ${now.toISOString()}, covering the last 24 hours.`,
    "",
    "Configuration for this report:",
    `- Repository: ${config.repo}`,
    `- Task label: ${config.label}`,
    `- Ready label: ${READY_LABEL}`,
    `- Stuck label: ${STUCK_LABEL}`,
    `- Child marker comment: ${CHILD_MARKER_TEMPLATE}`,
    `- Stopped marker comment: ${STOPPED_MARKER_TEMPLATE}`,
    "",
    "Run the daily report procedure from your instructions:",
    `1. List open pull requests labeled ${READY_LABEL} — waiting for the guardian to merge.`,
    `2. List open issues labeled ${STUCK_LABEL}, each with the reason from its newest comment.`,
    "3. List the labeled issues whose child coding session is still running, with what it is working on.",
    `4. List the pull requests labeled ${config.label} that merged since yesterday.`,
    `5. Count what went wrong in the last 24 hours, from what GitHub records: issues that gained the ${STUCK_LABEL} label, and issues whose newest marker comment is a stopped marker.`,
    "6. Write one short report covering those five, naming every item by number and URL. If nothing happened, say that in one line.",
    "Return the report as your final message. Do not send it — this action delivers it.",
  ].join("\n");
}

/**
 * Put the report in front of the guardian, as a chat with the Engineer agent
 * rather than a turn of the main agent. `system:send_user_message` opens the
 * session and posts the report into it, so the guardian can answer in the same
 * chat and reach the agent that wrote it. This is the only delivery path:
 * `system:send_message` needs a channel address for the guardian, and webchat
 * has none to resolve.
 */
async function deliver(
  appContext: RomeAppContext,
  text: string,
): Promise<{ delivered: true; sessionId: string } | { delivered: false; error: string }> {
  try {
    const posted = await appContext.runAction("system:send_user_message", {
      text,
      agentName: ENGINEER_AGENT,
      sessionName: REPORT_SESSION_NAME,
    });
    if (posted.status === "ok") {
      const data = posted.data as { sessionId?: unknown } | undefined;
      return {
        delivered: true,
        sessionId: typeof data?.sessionId === "string" ? data.sessionId : "",
      };
    }
    return {
      delivered: false,
      error: posted.status === "error" ? posted.error : `returned ${posted.status}`,
    };
  } catch (err) {
    return { delivered: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function createDailyReportAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<DailyReportDeps>,
): Action {
  const { agentRunner, appContext } = deps;

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
          description: "Label marking the issues and pull requests to report on.",
        },
      },
      required: ["repo", "projectPath"],
    },

    async execute(args): Promise<ActionResult> {
      const parsed = readConfig(args);
      if (!parsed.ok) {
        return { status: "error", error: parsed.error };
      }

      const prompt = buildReportPrompt(parsed.config, new Date());

      let report = "";
      for await (const msg of agentRunner.run({ agentName: ENGINEER_AGENT, prompt })) {
        if (msg.type === "result") {
          report = msg.content as string;
        } else if (msg.type === "error") {
          log.error("daily report agent failed", { error: msg.error });
          return { status: "error", error: `Engineer daily report failed: ${msg.error}` };
        }
      }

      if (!report.trim()) {
        return { status: "error", error: "Engineer daily report produced no text to deliver." };
      }

      const delivery = await deliver(appContext, report);
      if (!delivery.delivered) {
        log.error("daily report undelivered", { error: delivery.error });
        return {
          status: "error",
          error: `Engineer daily report was not delivered: ${delivery.error}`,
        };
      }

      log.info("daily report delivered", {
        repo: parsed.config.repo,
        sessionId: delivery.sessionId,
      });

      return {
        status: "ok",
        data: { repo: parsed.config.repo, sessionId: delivery.sessionId, report },
      };
    },
  };
}

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<DailyReportDeps>,
): Action {
  return createDailyReportAction(config, deps);
}
