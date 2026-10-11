import { trace } from "@opentelemetry/api";
import type { PolicyContext } from "@rome-os/app-runtime";
import type { Policy, PolicyRule, PolicyScope } from "../types.js";
import type { PoliciesRepository } from "../db/repositories/policies.js";
import type { SettingsRepository } from "../db/repositories/settings.js";

export type { PolicyContext } from "@rome-os/app-runtime";

type MatchedScope = "sender_specific" | "thread" | "sender_tier" | "channel" | "global" | "default";

const DEFAULT_TRUSTED_LEVELS = ["guardian"];

const DEFAULT_ALLOW: PolicyRule = { action: "allow" };
const DEFAULT_SENTINEL_REVIEW: PolicyRule = { action: "sentinel_review" };

function recordPolicyDecision(context: PolicyContext, rule: PolicyRule, scope: MatchedScope): void {
  // Emit as a span event on whatever parent span is active (typically
  // `action:message_handler`). Using an event rather than a dedicated span
  // keeps the decision inline with the surrounding action's timeline while
  // still being queryable via ClickHouse's span_events column.
  const span = trace.getActiveSpan();
  if (!span) return;
  span.addEvent("policy.decision", {
    "policy.decision": rule.action,
    "policy.matched_scope": scope,
    "policy.channel": context.channel,
    "policy.bond_level": context.bondLevel,
  });
}

export class PolicyEngine {
  constructor(
    private policiesRepo: PoliciesRepository,
    private settingsRepo: SettingsRepository,
  ) {}

  /**
   * Evaluate policies from most specific to most general.
   * Order: sender_specific → thread → sender tier → channel → global.
   * First matching policy wins. If none match, apply default based on trust.
   */
  async evaluate(context: PolicyContext): Promise<PolicyRule> {
    const allPolicies = await this.policiesRepo.findAll();

    const senderSpecific: Policy[] = [];
    const threadSpecific: Policy[] = [];
    const senderTier: Policy[] = [];
    const channel: Policy[] = [];
    const global: Policy[] = [];

    for (const policy of allPolicies) {
      switch (policy.scope.type) {
        case "sender_specific":
          senderSpecific.push(policy);
          break;
        case "thread":
          threadSpecific.push(policy);
          break;
        case "sender":
          senderTier.push(policy);
          break;
        case "channel":
          channel.push(policy);
          break;
        case "global":
          global.push(policy);
          break;
      }
    }

    if (context.sender) {
      for (const policy of senderSpecific) {
        const scope = policy.scope as Extract<PolicyScope, { type: "sender_specific" }>;
        if (scope.personId === context.sender.id && policy.rules.length > 0) {
          const rule = policy.rules[0];
          recordPolicyDecision(context, rule, "sender_specific");
          return rule;
        }
      }
    }

    if (context.threadName) {
      for (const policy of threadSpecific) {
        const scope = policy.scope as Extract<PolicyScope, { type: "thread" }>;
        if (
          scope.threadName === context.threadName &&
          (!context.threadType || scope.threadType === context.threadType)
        ) {
          if (policy.rules.length > 0) {
            const rule = policy.rules[0];
            recordPolicyDecision(context, rule, "thread");
            return rule;
          }
        }
      }
    }

    for (const policy of senderTier) {
      const scope = policy.scope as Extract<PolicyScope, { type: "sender" }>;
      if (scope.bondLevel === context.bondLevel && policy.rules.length > 0) {
        const rule = policy.rules[0];
        recordPolicyDecision(context, rule, "sender_tier");
        return rule;
      }
    }

    for (const policy of channel) {
      const scope = policy.scope as Extract<PolicyScope, { type: "channel" }>;
      if (scope.channel === context.channel && policy.rules.length > 0) {
        const rule = policy.rules[0];
        recordPolicyDecision(context, rule, "channel");
        return rule;
      }
    }

    for (const policy of global) {
      if (policy.rules.length > 0) {
        const rule = policy.rules[0];
        recordPolicyDecision(context, rule, "global");
        return rule;
      }
    }

    const trustedLevels =
      (await this.settingsRepo.get<string[]>("trustedBondLevels")) ?? DEFAULT_TRUSTED_LEVELS;
    const rule = trustedLevels.includes(context.bondLevel)
      ? DEFAULT_ALLOW
      : DEFAULT_SENTINEL_REVIEW;
    recordPolicyDecision(context, rule, "default");
    return rule;
  }
}
