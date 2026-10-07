import { createHash } from "node:crypto";
import { z } from "zod";
import type { DiagnosticBundle } from "./diagnostics.js";
import { FEEDBACK_BODY_MAX, FEEDBACK_SCHEMA_VERSION, type FeedbackReport } from "./feedback.js";
import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

export const AGENT_REPORTS_ENABLED_KEY = "feedback.agentReportsEnabled";

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
  .refine(({ summary, details }) => summary.length + 2 + details.length <= FEEDBACK_BODY_MAX, {
    message: "Composed feedback body must be at most 4000 characters",
  });

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

export const feedbackSendSchema = feedbackInputSchema.safeExtend({
  reporter: z
    .object({
      kind: z.literal("agent"),
      agentName: z.string().optional(),
      sessionId: z.string().optional(),
      turnId: z.string().optional(),
      executionId: z.string().optional(),
      callerAppId: z.string().optional(),
    })
    .strict(),
});

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

export interface FeedbackRelay extends FeedbackService {
  sendGuardian(input: { body: string; client: Record<string, unknown> }): Promise<FeedbackOutcome>;
}

export interface FeedbackClientDeps {
  diagnostics: () => Promise<DiagnosticBundle>;
  agentReportsEnabled: () => Promise<boolean>;
  getToken?: () => string | null;
  getOrigin?: () => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const AGENT_REPORT_LIMIT = 10;

/** Token and privacy policy stay in main and are read fresh on each call.
 * An unreachable outcome is ambiguous: the report may be stored. Do not retry. */
export class FeedbackClient implements FeedbackRelay {
  // In-memory runaway protection resets on restart. Count dispatch attempts,
  // including ambiguous outcomes, rather than only confirmed submissions.
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: FeedbackClientDeps) {}

  async send(input: AgentFeedback): Promise<FeedbackOutcome> {
    if (!(await this.deps.agentReportsEnabled())) return { kind: "disabled" };
    return this.relay({
      body: input.summary + "\n\n" + input.details,
      client: {
        category: input.category,
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
      },
      reporter: input.reporter,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify(
            [input.category, input.subject ?? "", input.summary].map((value) =>
              value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
            ),
          ),
        )
        .digest("hex"),
    });
  }

  async sendGuardian(input: {
    body: string;
    client: Record<string, unknown>;
  }): Promise<FeedbackOutcome> {
    return this.relay({ ...input, reporter: { kind: "guardian" } });
  }

  private async relay(input: {
    body: string;
    client: Record<string, unknown>;
    reporter: AgentReporter | { kind: "guardian" };
    fingerprint?: string;
  }): Promise<FeedbackOutcome> {
    const token = (this.deps.getToken ?? getInstanceToken)();
    if (!token) return { kind: "no_token" };
    const origin = (this.deps.getOrigin ?? getRomeCloudOrigin)();
    if (!origin) return { kind: "unconfigured" };
    // Match the guardian route's configuration-error classification.
    let url: URL;
    try {
      url = new URL("/api/instance/feedback", origin);
    } catch {
      return { kind: "unreachable" };
    }
    if (input.fingerprint) {
      const now = (this.deps.now ?? Date.now)();
      for (const [key, time] of this.attempts) {
        if (time <= now - WINDOW_MS) this.attempts.delete(key);
      }
      if (this.attempts.has(input.fingerprint)) return { kind: "duplicate" };
      if (this.attempts.size >= AGENT_REPORT_LIMIT) return { kind: "rate_limited" };
      // Reserve before awaiting diagnostics or HTTP so concurrent sends cannot
      // pass the same duplicate/cap check.
      this.attempts.set(input.fingerprint, now);
    }
    const diagnostics = await this.deps.diagnostics();
    const report: FeedbackReport = {
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      body: input.body,
      payload: { client: input.client, diagnostics: { ...diagnostics, reporter: input.reporter } },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 15_000);
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        cache: "no-store",
        body: JSON.stringify(report),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "relay_failed" }));
        return { kind: "rejected", status: response.status, body };
      }
      await response.body?.cancel().catch(() => {});
      return { kind: "ok" };
    } catch {
      return { kind: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
}
