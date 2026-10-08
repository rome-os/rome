// Agents connection: messages between this Rome and other agents on Rome
// Cloud, such as ChatGPT dots (amantru/rome-cloud#137), in this Rome's own
// account or in an account linked to it.
//
// Rome Cloud stores each message for this instance's endpoint until the
// instance acknowledges it, so the talker polls and acknowledges after
// delivering. The instance token is the credential and lives outside the
// grant; the grant only records the endpoint name Cloud assigned. A sender is
// never mapped to a person here. A sender Cloud marks as in this Rome's own
// account is linked to the guardian when its message is admitted
// (channels/agents-guardian.ts); any other sender stays unlinked, and the
// guardian decides whether Rome may answer it. A sender in another account is
// addressed as `@handle/endpoint`, and Cloud refuses a send to an agent whose
// owner has not linked with this Rome's account as `not_reachable`.

import type { ChannelMessage, ConversationId, OutgoingMessage } from "@rome-os/app-runtime";
import { z } from "zod";
import {
  type AgentMessageEnvelope,
  type AgentMessagingClient,
  AgentMessagingError,
  agentAddress,
  createRomeCloudAgentsClient,
  isNotReachable,
  isUndeliverable,
} from "../../lib/rome-cloud-agents.js";
import { createLogger } from "../../logger.js";
import { CredentialRejected } from "../errors.js";
import type { SetupFn } from "../setup/types.js";
import { addressIsConversationFeature } from "./talk-features.js";
import type {
  AuthScheme,
  ConnectionDescriptor,
  Credential,
  ProfileDisplay,
  ProfileRecord,
  StreamFault,
  TalkFeatures,
  Talker,
} from "../types.js";

const log = createLogger("agents-channel");

export const AGENTS_SERVICE = "agents";
const POLL_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 5 * 60_000;
/** Cloud returns at most this many messages per poll; a full page polls again at once. */
const POLL_PAGE_SIZE = 50;

export const agentsGrantProfileSchema = z.object({ endpoint: z.string().min(1) }).strict();

export function reviveAgentsProfile(record: ProfileRecord): ProfileDisplay {
  const { endpoint } = agentsGrantProfileSchema.parse(record);
  return Object.freeze({
    displayName: undefined,
    handle: endpoint,
    email: undefined,
    avatarUrl: undefined,
  });
}

/**
 * An agent message as a channel message. The sender's address is the
 * conversation. Null for a cross-account sender Cloud named no account for,
 * whose bare name could pass for one of the guardian's own agents.
 */
export function toAgentInboundMessage(message: AgentMessageEnvelope): ChannelMessage | null {
  const sender = agentAddress(message.from);
  if (sender === null) return null;
  const data =
    message.data && Object.keys(message.data).length > 0
      ? `\n\nData:\n\`\`\`json\n${JSON.stringify(message.data, null, 2)}\n\`\`\``
      : "";
  // The address already reads as another account's, and the label says so
  // wherever the sender's own name stands in for a person's.
  const kind =
    message.from.sameAccount === false ? `external ${message.from.kind}` : message.from.kind;
  return {
    channel: AGENTS_SERVICE,
    direction: "inbound",
    messageId: message.messageId,
    conversationId: sender as ConversationId,
    senderId: sender,
    senderDisplayName: `${sender} (${kind})`,
    text: `${message.text}${data}`,
    attachments: [],
    timestamp: new Date(message.sentAt),
    ...(message.inReplyTo ? { replyTo: { messageId: message.inReplyTo } } : {}),
    thread: { kind: "dm" },
    raw: message,
  };
}

function outgoingText(message: OutgoingMessage): string {
  if (message.text?.trim()) return message.text;
  return (message.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("\n\n");
}

/** Whether Cloud refused the instance token itself, which no retry fixes: the
 *  token is unknown or revoked, or this Rome is no longer linked. */
function isRejectedToken(err: unknown): boolean {
  if (!(err instanceof AgentMessagingError)) return false;
  return err.status === 401 || err.status === 403 || err.code === "no_token";
}

export function makeAgentsSetup(client: AgentMessagingClient): SetupFn {
  return async (interact, ctx) => {
    interact.show({
      title: "Connecting to Rome Cloud",
      body: ["Creating this Rome's endpoint…"],
      progress: true,
    });
    const { endpoint } = await ctx.step("register", () => client.endpoints());
    return {
      credential: { material: { endpoint }, expiresAt: "never" },
      profile: agentsGrantProfileSchema.parse({ endpoint }),
      summary: {
        title: "Agents connected",
        body: [
          `Agents in your Rome Cloud account can message this Rome as ${endpoint}.`,
          "Pair a dot under Settings → Agents in Rome Cloud.",
        ],
      },
    };
  };
}

function agentsScheme(client: AgentMessagingClient): AuthScheme {
  return {
    async confer(): Promise<Credential> {
      throw new Error("conferral driven by the connect setup");
    },
    // The instance token is the real credential and Cloud renews nothing here.
    // A token Cloud still refuses needs the guardian, so renewal only confirms
    // it works; returning it unchanged would rebuild a talker that faults again.
    async renew(cred: Credential): Promise<Credential | "re-confer"> {
      try {
        await client.endpoints();
      } catch (err) {
        if (isRejectedToken(err)) return "re-confer";
      }
      return cred;
    },
    setup: makeAgentsSetup(client),
  };
}

export function createAgentsTalker(client: AgentMessagingClient): Talker {
  let generation = 0;
  let cancelWait: (() => void) | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        cancelWait = null;
        resolve();
      }
      cancelWait = done;
    });

  async function loop(
    current: number,
    deliver: (msg: ChannelMessage) => void,
    fault: (err: StreamFault) => void,
  ) {
    let failures = 0;
    while (current === generation) {
      let delay = POLL_INTERVAL_MS;
      try {
        const { messages } = await client.poll();
        if (current !== generation) return;
        for (const message of messages) {
          const inbound = toAgentInboundMessage(message);
          if (inbound) {
            deliver(inbound);
          } else {
            log.warn("Dropped a cross-account agent message that named no sender account", {
              messageId: message.messageId,
            });
          }
        }
        // Delivery is at most once, as for every channel; a repeat after a
        // failed acknowledgement keeps its messageId and the inbox drops it.
        await client.acknowledge(messages.map((message) => message.messageId));
        failures = 0;
        if (messages.length >= POLL_PAGE_SIZE) delay = 0;
      } catch (err) {
        if (current !== generation) return;
        if (isRejectedToken(err)) {
          fault(new CredentialRejected({ grant: "cloud", cause: err }));
          return;
        }
        failures++;
        delay = Math.min(POLL_INTERVAL_MS * 2 ** failures, MAX_BACKOFF_MS);
        log.warn("Agent message poll failed", {
          error: err instanceof Error ? err.message : String(err),
          retryInMs: delay,
        });
      }
      if (delay > 0) await wait(delay);
    }
  }

  // An agent's address is both how Cloud reaches it and the conversation its
  // messages arrive in, so Rome can write to a dot first, from the People
  // page, as well as answer one.
  const features: TalkFeatures = {
    directMessaging: addressIsConversationFeature(),
  };
  return {
    start(deliver, fault) {
      const current = ++generation;
      void loop(current, deliver, fault);
    },
    stop() {
      generation++;
      cancelWait?.();
    },
    async send(conversationId, msg) {
      // Cloud carries text and data only. Refusing here keeps a partial send
      // from being reported, and recorded, as if the files went too.
      if (msg.attachments?.length) {
        throw new Error("Agent messages carry text only; send the files another way.");
      }
      // Cloud also takes `handle/endpoint`, but its reply would come back as
      // `@handle/endpoint` and split the conversation in two.
      if (/^[^@\s/]+\/[^\s/]+$/.test(conversationId)) {
        throw new Error(`Address another account's agent as @${conversationId}.`);
      }
      const text = outgoingText(msg);
      if (!text.trim()) throw new Error("An agent message needs text.");
      try {
        const sent = await client.send({
          to: conversationId,
          text,
          ...(msg.replyToMessageId ? { inReplyTo: msg.replyToMessageId } : {}),
        });
        // Cloud answers with the address its reply will come from: the bare
        // name for an own agent written to as `@ownhandle/name`.
        return {
          conversationId: (sent.to || conversationId) as ConversationId,
          messageId: sent.messageId,
        };
      } catch (err) {
        if (!isUndeliverable(err)) throw err;
        // Cloud says `not_reachable` only for another account's agent, which a
        // missing link can put out of reach; an own agent is `unknown_endpoint`.
        const why = isNotReachable(err)
          ? "The agent may not exist, or no link between your accounts lets this Rome reach it."
          : "The agent may no longer exist.";
        throw new Error(`Rome Cloud can't deliver to ${conversationId}. ${why}`, { cause: err });
      }
    },
    ...features,
  };
}

export function makeAgentsDescriptor(
  client: AgentMessagingClient = createRomeCloudAgentsClient(),
): ConnectionDescriptor {
  return {
    service: AGENTS_SERVICE,
    reviveProfile: (_grant, record) => reviveAgentsProfile(record),
    auth: { cloud: agentsScheme(client) },
    capabilities: {
      talker: {
        needs: ["cloud"] as const,
        build: () => createAgentsTalker(client),
      },
    },
  };
}
