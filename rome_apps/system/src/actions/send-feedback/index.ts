import { defineAction, getCurrentActionContext, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";

/** Structural copies of core's feedback-client contract. Keep in sync: apps
 * cannot import core, and workers receive a proxy instead of the real client. */
export interface AgentReporter {
  kind: "agent";
  agentName?: string;
  sessionId?: string;
  turnId?: string;
  executionId?: string;
  /** Set when an installed app, not an agent turn, invoked the action. */
  callerAppId?: string;
}

export type AgentFeedback = z.infer<typeof feedbackInputSchema> & { reporter: AgentReporter };

export type FeedbackOutcome =
  | { kind: "ok" }
  | { kind: "no_token" }
  | { kind: "unconfigured" }
  | { kind: "rejected"; status: number; body: unknown }
  | { kind: "unreachable" }
  | { kind: "rate_limited" }
  | { kind: "duplicate" }
  | { kind: "disabled" };

export interface FeedbackService {
  send(input: AgentFeedback): Promise<FeedbackOutcome>;
}

/** Runtime limits are checked against core by feedback-structural-sync.test.ts. */
export const feedbackInputSchema = z
  .object({
    category: z.enum(["bug", "missing_capability", "docs_or_skill", "ux", "other"]),
    summary: z
      .string()
      .regex(/^[^\r\n\u2028\u2029]*$/, "Summary must be one line")
      .trim()
      .min(1)
      .max(160),
    details: z.string(),
    subject: z.string().max(200).optional(),
  })
  .strict()
  .refine(({ summary, details }) => summary.length + 2 + details.length <= 4000, {
    message: "Composed feedback body must be at most 4000 characters",
  });

export interface SendFeedbackDeps {
  feedback: FeedbackService;
}

export function createSendFeedbackAction(config: ActionConfig, deps: SendFeedbackDeps): Action {
  return defineAction({
    config,
    schema: feedbackInputSchema,
    async execute(input): Promise<ActionResult> {
      const context = getCurrentActionContext();
      // Agents report; installed apps must not open a channel into Rome triage
      // or spend the agent budget.
      if (context?.callerAppId && context.callerAppId !== "system") {
        return { status: "error", error: "app_callers_not_supported" };
      }
      const outcome = await deps.feedback.send({
        ...input,
        reporter: {
          kind: "agent",
          agentName: context?.agentName,
          sessionId: context?.sessionId,
          turnId: context?.turnId,
          executionId: context?.executionId,
          ...(context?.callerAppId ? { callerAppId: context.callerAppId } : {}),
        },
      });
      switch (outcome.kind) {
        case "ok":
          return { status: "ok" };
        case "rejected":
          return { status: "error", error: `feedback_rejected_${outcome.status}` };
        case "unreachable":
          return {
            status: "error",
            error: "feedback_outcome_unknown: The report may have been filed. Do not retry.",
          };
        case "no_token":
        case "unconfigured":
        case "rate_limited":
        case "duplicate":
        case "disabled":
          return { status: "error", error: outcome.kind };
        default: {
          const exhaustive: never = outcome;
          void exhaustive;
          return {
            status: "error",
            error: "feedback_outcome_unknown: Do not retry.",
          };
        }
      }
    },
  });
}

export function createAction(config: ActionConfig, deps: SendFeedbackDeps): Action {
  if (typeof deps.feedback?.send !== "function") {
    throw new Error("send_feedback requires a feedback capability with a send() method");
  }
  return createSendFeedbackAction(config, deps);
}
