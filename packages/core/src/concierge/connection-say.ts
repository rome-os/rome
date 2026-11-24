// What the Concierge says in a chat on one of Rome's connected accounts, such
// as a Discord or Slack chat. `say` is the same tool as on the dashboard; only
// its last step differs: the message goes out as the inbox sends an agent's
// reply, past the send gate, and Envoy where the gate asks, to the platform
// (docs/domains/participation.md#send-gate, docs/architecture/concierge.md).

import type { BondLevel } from "@rome-os/app-runtime";

/** The chat on a connection a message goes to. */
export interface ConnectionChat {
  /** The chat's id in Rome. */
  id: string;
  channel: string;
  /** The platform's id for the chat. */
  threadId: string;
}

/** Whom a message answers: the sender of the turn's message, as People knows
 *  them. A task's report answers the guardian, who started the task. */
export interface ConnectionRecipient {
  bondLevel: BondLevel;
  /** The name their message showed. */
  shownName: string;
  /** What they said, which Envoy reads the reply against. */
  said: string;
}

export type EnvoyVerdict = {
  action: "approve" | "require_approval" | "reject";
  reason?: string;
};

export type SendGateDecision = "send" | "check" | "ask_guardian" | "refuse";

/** The account's send gate, as core wires it (participation/send-gate): may
 *  a message go out, and does Envoy check it first. */
type SendGate = (request: {
  destination: {
    connectionId: string;
    chatId: string;
    place: "direct" | "group";
    sameChatAsWake: boolean;
    onlyGuardianReads: boolean;
  };
  recipient: { bondLevel: BondLevel } | null;
  author: { agentName: string };
}) => SendGateDecision;

export interface ConnectionSayDeps {
  gate: SendGate;
  /** The connection that carries `channel`, or null when none does. */
  connectionOf: (channel: string) => string | null;
  /** Envoy's verdict on `text` as a reply to `recipient`. */
  envoy: (input: {
    text: string;
    recipient: ConnectionRecipient;
    place: "direct" | "group";
  }) => Promise<EnvoyVerdict>;
  /** Sends `text` to the chat, quoting the message keyed `replyTo` when
   *  given, and records it as turn `turnId`'s. Answers the platform's key. */
  send: (
    chat: ConnectionChat,
    text: string,
    replyTo: string | undefined,
    turnId: string,
  ) => Promise<string>;
  /** Puts the gate's decision on record, as the inbox does for a reply. */
  record: (decision: {
    status: "auto_approved" | "pending" | "rejected";
    description: string;
    chat: Pick<ConnectionChat, "channel" | "threadId">;
    text: string;
  }) => Promise<void>;
}

export type ConnectionSaid =
  | { sent: string }
  /** The message waits for the guardian, or never goes out: the reason, in
   *  words the Concierge reads. */
  | { notSent: string };

/** Says `text` in `chat`, past the send gate. */
export async function sayOnConnection(
  deps: ConnectionSayDeps,
  input: {
    chat: ConnectionChat;
    text: string;
    replyTo?: string;
    turnId: string;
    place: "direct" | "group";
    recipient: ConnectionRecipient;
  },
): Promise<ConnectionSaid> {
  const { chat, text, recipient, place } = input;
  const connectionId = deps.connectionOf(chat.channel);
  if (!connectionId) throw new Error("This chat's account cannot send.");
  const decision = deps.gate({
    destination: {
      connectionId,
      chatId: chat.threadId,
      place,
      sameChatAsWake: true,
      onlyGuardianReads: place === "direct" && recipient.bondLevel === "guardian",
    },
    recipient: { bondLevel: recipient.bondLevel },
    author: { agentName: "core:concierge" },
  });
  const send = async (description: string) => {
    const sent = await deps.send(chat, text, input.replyTo, input.turnId);
    await deps.record({ status: "auto_approved", description, chat, text });
    return { sent };
  };
  if (decision === "send") return send("Sent past the send gate");
  if (decision === "refuse") {
    await deps.record({ status: "rejected", description: "Refused by the send gate", chat, text });
    return { notSent: "The send gate refused this message, so it was not sent." };
  }
  if (decision === "ask_guardian") {
    await deps.record({ status: "pending", description: "Held by the send gate", chat, text });
    return { notSent: "This message waits for the guardian's approval, so it was not sent yet." };
  }
  const verdict = await deps.envoy({ text, recipient, place });
  if (verdict.action === "approve") return send(verdict.reason ?? "Envoy approved");
  if (verdict.action === "require_approval") {
    await deps.record({
      status: "pending",
      description: verdict.reason ?? "Envoy flagged for approval",
      chat,
      text,
    });
    return { notSent: "This message waits for the guardian's approval, so it was not sent yet." };
  }
  await deps.record({
    status: "rejected",
    description: verdict.reason ?? "Envoy rejected",
    chat,
    text,
  });
  return {
    notSent: `This message was not sent: ${verdict.reason ?? "it may not go to this chat"}.`,
  };
}

export interface ConnectionSendDeps
  extends Pick<ConnectionSayDeps, "gate" | "connectionOf" | "record"> {
  /** Sends `text` to the platform address `address` on `channel`, as turn
   *  `turnId`'s, and records it there. Answers the platform's key. */
  deliver: (channel: string, address: string, text: string, turnId: string) => Promise<string>;
}

/**
 * Sends `text` to chat `chat`, in thread `thread` or its open chat, on the
 * account chat `from` is on, past the send gate. It answers no message said
 * there, so Envoy, which reads a reply against the message it answers, has
 * nothing to read it against: a send the gate would check waits for the
 * guardian instead.
 */
export async function sendOnConnection(
  deps: ConnectionSendDeps,
  input: {
    from: Pick<ConnectionChat, "channel" | "threadId">;
    chat: string;
    thread?: string;
    text: string;
    turnId: string;
  },
): Promise<ConnectionSaid> {
  const { from, text } = input;
  const connectionId = deps.connectionOf(from.channel);
  if (!connectionId) throw new Error("This chat's account cannot send.");
  // A thread's platform id is the address a message to it goes to.
  const target = { channel: from.channel, threadId: input.thread ?? input.chat };
  const decision = deps.gate({
    destination: {
      connectionId,
      chatId: input.chat,
      place: "group",
      sameChatAsWake: input.chat === from.threadId,
      onlyGuardianReads: false,
    },
    recipient: null,
    author: { agentName: "core:concierge" },
  });
  if (decision === "send") {
    const sent = await deps.deliver(from.channel, target.threadId, text, input.turnId);
    await deps.record({
      status: "auto_approved",
      description: "Sent past the send gate",
      chat: target,
      text,
    });
    return { sent };
  }
  if (decision === "refuse") {
    await deps.record({
      status: "rejected",
      description: "Refused by the send gate",
      chat: target,
      text,
    });
    return { notSent: "The send gate refused this message, so it was not sent." };
  }
  await deps.record({
    status: "pending",
    description: "Held by the send gate",
    chat: target,
    text,
  });
  return { notSent: "This message waits for the guardian's approval, so it was not sent yet." };
}

const BOND_LEVEL_WORDS: Record<string, string> = {
  guardian: "guardian",
  "inner-circle": "inner circle",
  acquaintance: "acquaintance",
  other: "other",
};

/** Envoy's prompt for a reply, as the inbox words it for an agent's reply. */
export function envoyPrompt(input: {
  text: string;
  recipient: ConnectionRecipient;
  place: "direct" | "group";
}): string {
  const { recipient } = input;
  const who = `${recipient.shownName} [${BOND_LEVEL_WORDS[recipient.bondLevel] ?? recipient.bondLevel}]`;
  return [
    "Validate this outgoing message before it is sent.",
    "",
    `Message being answered, from ${who}:`,
    recipient.said,
    "",
    `The reply goes to that sender, in the same ${input.place === "direct" ? "direct message" : "group chat"} the message was sent in.`,
    "The sender is not the guardian: the guardian's replies skip this check.",
    "Replying agent: core:concierge",
    "",
    "Proposed reply:",
    input.text,
  ].join("\n");
}

const VERDICTS = ["approve", "require_approval", "reject"] as const;

/** Envoy's verdict from its structured answer. An answer with no known
 *  verdict holds the message for the guardian. */
export function readEnvoyVerdict(structured: unknown): EnvoyVerdict {
  const answer =
    structured && typeof structured === "object"
      ? (structured as { verdict?: unknown; reason?: unknown })
      : undefined;
  const action = VERDICTS.find((verdict) => verdict === answer?.verdict);
  if (!action) return { action: "require_approval", reason: "Envoy answered without a verdict" };
  return typeof answer?.reason === "string" ? { action, reason: answer.reason } : { action };
}
