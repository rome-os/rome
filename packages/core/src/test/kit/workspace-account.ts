// An account of a kind of connection that serves its whole workspace, booted
// in process over the pieces `index.ts` wires for Rome's Slack app: the wake
// gate, the account's one session, catch-up through the kind's talk history,
// and the Concierge with `say` and `send` past the account's send gate
// (docs/domains/participation.md#workspace-account). The caller gives the
// kind's descriptor, its read and send ports, and the model.
//
// What it leaves out: the inbox app's hook, which in production records each
// message in Chats and hands it to the session; here `deliver` does both
// steps itself. The sender's name goes before the message's text, where
// Chats' label shows it in production.

import { join } from "node:path";
import type { ChatId } from "@rome-os/app-runtime";
import { and, eq } from "drizzle-orm";
import { romeAgentMessages } from "../../db/schema.js";
import { SenderLabels } from "../../chats/sender-labels.js";
import { buildConciergeTools } from "../../concierge/tools.js";
import { sayOnConnection, sendOnConnection } from "../../concierge/connection-say.js";
import { conciergePlaceSetup } from "../../concierge/on-connection.js";
import { type ConciergeDeps, ConciergeService } from "../../concierge/service.js";
import { ConciergeTasks } from "../../concierge/tasks.js";
import type { ConnectionDescriptor, TalkHistory } from "../../connections/types.js";
import type { ModelProvider } from "../../core/agent-runner.js";
import { chatPromptFacts } from "../../core/chat-prompt-facts.js";
import { workspaceSessions } from "../../core/workspace-sessions.js";
import { ConciergeTasksRepository } from "../../db/repositories/concierge-tasks.js";
import { actsWithGuardianAccess } from "../../participation/guardian-access.js";
import { guardedSend, workspaceSend } from "../../participation/send-gate/index.js";
import { chatSettingsWake } from "../../participation/wake-gate/index.js";
import { CONCIERGE_AGENT_ID } from "../../webchat/privacy.js";
import { createTestRome, type TestRome } from "./test-rome.js";

const CONCIERGE_FILE = join(import.meta.dirname, "..", "..", "..", "agents", "concierge.yaml");

/** The kind's own ports: what a stand-in for the platform answers. A thread's
 *  address is its chat's id, a colon, and the thread's own id, as Rome names
 *  a platform thread inside its chat; a chat's id holds no colon. */
export interface WorkspaceKindPorts {
  /** The chat's or thread's messages, as a read of the kind's talk history. */
  history: TalkHistory;
  /** Sends `text` to `chat`, in thread `thread` (its whole address) or the
   *  open chat. Answers the platform's id for the message. */
  send(place: { chat: string; thread?: string }, text: string): Promise<string>;
}

export interface WorkspaceAccountOptions {
  /** The kind of connection, which must declare `servesWorkspace: true`. */
  kind: ConnectionDescriptor;
  ports: WorkspaceKindPorts;
  /** The model the Concierge runs on. */
  model: ModelProvider;
  /** The connection's id. Defaults to `workspace`. */
  connectionId?: string;
}

/** A message said in the workspace, as the connection would deliver it. */
export interface WorkspaceMessage {
  /** The platform's id for the message. Defaults to a new one. */
  id?: string;
  /** The sender's platform id. */
  sender: string;
  senderName?: string;
  chat: string;
  /** The thread's whole address, for a message said in a thread. */
  thread?: string;
  text: string;
  /** Said in a direct message with Rome's account. */
  direct?: boolean;
  /** Mentions Rome's account. */
  mentionsRome?: boolean;
}

/** A message Rome sent, and where. */
export interface WorkspaceSent {
  chat: string;
  thread: string | null;
  text: string;
}

export interface WorkspaceAccount {
  /** Delivers `message`. When it wakes the agent, resolves once the agent's
   *  turn on it has ended. Answers whether it woke the agent. */
  deliver(message: WorkspaceMessage): Promise<{ woke: boolean }>;
  /** Every message Rome sent, in order. */
  readonly sent: readonly WorkspaceSent[];
  /** The harness underneath, for a test that reads more. */
  readonly rome: TestRome;
  close(): Promise<void>;
}

/**
 * Boots an account of `kind` serving its workspace, in process. One harness
 * runs at a time: close it before booting another.
 */
export async function bootWorkspaceAccount(
  options: WorkspaceAccountOptions,
): Promise<WorkspaceAccount> {
  const { kind, ports } = options;
  if (kind.servesWorkspace !== true) {
    throw new Error(`Kind ${kind.connectionKind} does not declare servesWorkspace: true`);
  }
  const channel = kind.connectionKind;
  const connectionId = options.connectionId ?? "workspace";
  const servesWorkspace = (id: string) => id === connectionId;
  const onAccount = (name: string) => name === channel;
  const sent: WorkspaceSent[] = [];
  // The thread of each message delivered, by its platform id.
  const threadOf = new Map<string, string | undefined>();
  let rome: TestRome | null = null;
  const harness = () => {
    if (!rome) throw new Error("The workspace account is not booted");
    return rome;
  };

  const sendTo = async (address: string, text: string) => {
    const colon = address.indexOf(":");
    const place =
      colon === -1 ? { chat: address } : { chat: address.slice(0, colon), thread: address };
    const key = await ports.send(place, text);
    sent.push({ chat: place.chat, thread: place.thread ?? null, text });
    return key;
  };
  // The thread the message turn `turnId` answers was said in.
  const threadOfTurn = (turnId: string) => {
    const row = harness()
      .db.select({ key: romeAgentMessages.platformMessageId })
      .from(romeAgentMessages)
      .where(and(eq(romeAgentMessages.turnId, turnId), eq(romeAgentMessages.role, "user")))
      .get();
    return row?.key ? threadOf.get(row.key) : undefined;
  };
  const gate = workspaceSend(servesWorkspace, guardedSend);
  const connectionOf = (name: string) => (onAccount(name) ? connectionId : null);

  const promptFacts = chatPromptFacts({
    facts: { unseen: () => [], seen: () => undefined },
    messages: { byIds: () => [] },
    labels: new SenderLabels({ byAccount: async () => null }),
    channelOfChat: (chatId) => harness().webchat.channelOfChat(chatId),
    channelSurface: () => ({ interactiveCards: false, promptContext: true }),
    latest: (place, read) => ports.history.read(place.threadId as ChatId, read),
    servesWorkspace,
    connectionOfChannel: connectionOf,
  });

  let service: ConciergeService | null = null;
  rome = await createTestRome({
    agentFiles: [CONCIERGE_FILE],
    modelProvider: options.model,
    keepAliveAcrossTurns: true,
    recordChats: true,
    promptFacts,
    placeSetup: (agentName, thread) =>
      conciergePlaceSetup(agentName, thread, (place) =>
        servesWorkspace(place.connectionId ?? connectionOf(place.channel) ?? ""),
      ),
    sessionTools: (context) => {
      if (!service) throw new Error("The Concierge is not booted");
      return buildConciergeTools(service, context);
    },
    wrapSessions: (sessions) => workspaceSessions(sessions, servesWorkspace),
  });
  const booted = rome;
  const deps: Pick<
    ConciergeDeps,
    | "webchatRepo"
    | "tasks"
    | "channelAgentOf"
    | "servesWorkspace"
    | "guardianAccess"
    | "sayInChat"
    | "sendInChat"
  > = {
    webchatRepo: booted.webchat as unknown as ConciergeDeps["webchatRepo"],
    tasks: new ConciergeTasks(new ConciergeTasksRepository(booted.db)),
    channelAgentOf: (name: string) => (onAccount(name) ? CONCIERGE_AGENT_ID : null),
    servesWorkspace: onAccount,
    guardianAccess: (name: string, guardian: boolean) =>
      actsWithGuardianAccess({ servesWorkspace: onAccount(name), guardian }),
    sayInChat: (chat, message) =>
      sayOnConnection(
        {
          gate,
          connectionOf,
          // The workspace's gate sends without a check, so Envoy is never asked.
          envoy: async () => ({ action: "require_approval" }),
          send: async (target, text, _replyTo, turnId) => {
            const thread = threadOfTurn(turnId);
            return sendTo(thread ?? target.threadId, text);
          },
          record: async () => {},
        },
        { chat, ...message },
      ),
    sendInChat: (from, message) =>
      sendOnConnection(
        {
          gate,
          connectionOf,
          deliver: async (_channel, address, text) => sendTo(address, text),
          record: async () => {},
        },
        { from, ...message },
      ),
  };
  // Only what a turn on a connection reads is given: the rest of the
  // Concierge's dashboard is never reached there.
  service = new ConciergeService(deps as unknown as ConciergeDeps);

  const wake = chatSettingsWake({
    enabled: true,
    replyRule: "mention",
    botMessages: "ignore",
    whenOthersMentioned: "ignore",
    replyToLevels: ["guardian"],
    trustedLevels: ["guardian"],
    policies: [],
    connectionKindOf: () => channel,
    servesWorkspace: true,
  });

  let next = 0;
  return {
    sent,
    rome: booted,
    async deliver(message) {
      const decision = wake(
        {
          connectionId,
          chatId: message.chat,
          channel,
          place: message.direct ? "direct" : "group",
          addressing: message.direct ? "direct" : message.mentionsRome ? "mention" : "ambient",
        },
        { person: null },
      );
      if (decision !== "wake") return { woke: false };
      const id = message.id ?? `kit-${++next}`;
      threadOf.set(id, message.thread);
      const chat = await booted.webchat.ensureChannelChat({
        channel,
        threadId: message.chat,
        threadType: message.direct ? "private" : "group",
        agentName: CONCIERGE_AGENT_ID,
      });
      const said = message.senderName ? `${message.senderName}: ${message.text}` : message.text;
      await booted.webchat.addConversationMessage({
        sessionId: chat.id,
        role: "user",
        content: said,
        platformMessageId: id,
        senderId: message.sender,
        ...(message.senderName ? { senderName: message.senderName } : {}),
      });
      for await (const _event of booted.agentRunner.run({
        agentName: CONCIERGE_AGENT_ID,
        prompt: said,
        channelThreadKey: `${channel}:${message.chat}`,
        romeSessionId: chat.id,
        platformMessageId: id,
        ...(message.thread ? { inThread: message.thread as ChatId } : {}),
        threadContext: {
          connectionId,
          channel,
          threadId: message.chat,
          channelUserId: message.sender,
          threadType: message.direct ? "private" : "group",
        },
      })) {
        // The turn's events: the kit waits for its end.
      }
      return { woke: true };
    },
    close: () => booted.cleanup(),
  };
}
