import { trace } from "@opentelemetry/api";
import type { PolicyContext } from "@rome-os/app-runtime";
import type { Policy, PolicyRule, PolicyScope } from "../../../types.js";
import type { PoliciesRepository } from "../../../db/repositories/policies.js";
import type { ConnectionKindOfChannel } from "../../../db/repositories/channel-records.js";

export type { PolicyContext } from "@rome-os/app-runtime";

type MatchedScope = "sender_specific" | "thread" | "channel" | "global" | "default";

const DEFAULT_ALLOW: PolicyRule = { action: "allow" };
const DEFAULT_SENTINEL_REVIEW: PolicyRule = { action: "sentinel_review" };

/** The bond levels {@link PolicyEngine.evaluate} allowed with no policy, as it
 *  did before entry decided who may start something. */
const DEFAULT_TRUSTED_LEVELS: readonly string[] = ["guardian"];

function recordPolicyDecision(
  context: { channel: string },
  rule: PolicyRule,
  scope: MatchedScope,
): void {
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
  });
}

/** What a policy decision is made from: the policies the guardian set, and
 *  the connection kind of each channel. */
export interface PolicyInput {
  policies: readonly Policy[];
  connectionKindOf: ConnectionKindOfChannel;
}

/**
 * The rule of the policy that applies to a message, from most specific to most
 * general: sender_specific → thread → channel → global. The first matching
 * policy wins, and null means none matches. A policy stored for a bond level
 * matches nothing: who may start something is decided on the way in.
 */
export function matchingPolicy(
  input: PolicyInput,
  context: Omit<PolicyContext, "bondLevel" | "sender"> & { sender: { id: string } | null },
): PolicyRule | null {
  const senderSpecific: Policy[] = [];
  const threadSpecific: Policy[] = [];
  const channel: Policy[] = [];
  const global: Policy[] = [];

  for (const policy of input.policies) {
    switch (policy.scope.type) {
      case "sender_specific":
        senderSpecific.push(policy);
        break;
      case "thread":
        threadSpecific.push(policy);
        break;
      case "sender":
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

  // A policy on a later channel's own name wins; one on its connection kind covers
  // it otherwise, as People keys an account by connection kind. Most installs have
  // no channel policy, so the connection kind is only looked up when one exists.
  const connectionKind =
    channel.length > 0 ? input.connectionKindOf(context.channel) : context.channel;
  for (const name of connectionKind !== context.channel
    ? [context.channel, connectionKind]
    : [context.channel]) {
    for (const policy of channel) {
      const scope = policy.scope as Extract<PolicyScope, { type: "channel" }>;
      if (scope.channel === name && policy.rules.length > 0) {
        const rule = policy.rules[0];
        recordPolicyDecision(context, rule, "channel");
        return rule;
      }
    }
  }

  for (const policy of global) {
    if (policy.rules.length > 0) {
      const rule = policy.rules[0];
      recordPolicyDecision(context, rule, "global");
      return rule;
    }
  }

  return null;
}

/** @deprecated Read by no app of Rome's. Kept for one release, as the SDK
 *  publishes its type. */
export class PolicyEngine {
  constructor(
    private policiesRepo: PoliciesRepository,
    private connectionKindOf: ConnectionKindOfChannel,
  ) {}

  /** {@link matchingPolicy} on the stored policies. With none, it answers as
   *  it always has for an app that calls it: allow for the guardian, and
   *  sentinel review for anyone else. */
  async evaluate(context: PolicyContext): Promise<PolicyRule> {
    const matched = matchingPolicy(
      { policies: await this.policiesRepo.findAll(), connectionKindOf: this.connectionKindOf },
      context,
    );
    if (matched) return matched;
    const rule = DEFAULT_TRUSTED_LEVELS.includes(context.bondLevel)
      ? DEFAULT_ALLOW
      : DEFAULT_SENTINEL_REVIEW;
    recordPolicyDecision(context, rule, "default");
    return rule;
  }
}
