import { trace } from "@opentelemetry/api";
import type { Policy, PolicyRule, PolicyScope } from "../../../types.js";
import type { ConnectionKindOfChannel } from "../../../db/repositories/channel-records.js";

type MatchedScope = "thread" | "channel" | "global";

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

/** Where a message was said, as a policy matches it. */
export interface PolicyContext {
  channel: string;
  threadName?: string;
  threadType?: string;
}

/**
 * The rule of the policy that applies to a message, from most specific to most
 * general: thread → channel → global. The first matching policy wins, and null
 * means none matches. A policy an earlier release stored for a sender matches
 * nothing: who may start something is decided on the way in.
 */
export function matchingPolicy(input: PolicyInput, context: PolicyContext): PolicyRule | null {
  const threadSpecific: Policy[] = [];
  const channel: Policy[] = [];
  const global: Policy[] = [];

  for (const policy of input.policies) {
    switch (policy.scope.type) {
      case "thread":
        threadSpecific.push(policy);
        break;
      case "channel":
        channel.push(policy);
        break;
      case "global":
        global.push(policy);
        break;
      default:
        // An earlier release's sender scope, kept in the table and never matched.
        break;
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
  // it otherwise. Most installs have no channel policy, so the connection kind is
  // only looked up when one exists.
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
