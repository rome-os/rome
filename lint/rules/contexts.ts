// Import rules between contexts, each a folder directly under
// packages/core/src. ALLOWED_IMPORTS names, for every context, the other
// contexts it may import. Every pair of contexts it does not name is a rule:
// the first context never imports the second, type-only imports included.
// Folders that are not listed here, such as db/, lib/ and the folders not yet
// in a context, are not checked here. rules/library.ts checks lib/.

import type { ImportRule, ListedCrossing } from "../import-rules.js";

const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  access: ["identity", "instance"],
  agent: ["instance"],
  "app-host": [
    "access",
    "agent",
    "apps",
    "chats",
    "concierge",
    "connections",
    "favors",
    "instance",
    "participation",
    "people",
    "relay",
    "routines",
    "webchat",
  ],
  apps: ["access", "instance"],
  chats: ["access", "agent", "apps", "connections", "identity", "participation", "people"],
  concierge: ["access", "agent", "apps", "chats", "connections", "instance", "routines", "webchat"],
  connections: ["apps", "desktops", "instance"],
  desktops: ["access", "instance"],
  favors: ["access", "apps", "instance"],
  identity: [],
  instance: [],
  participation: [],
  people: ["apps", "chats", "connections", "instance"],
  relay: ["apps", "instance"],
  routines: ["access", "agent", "apps"],
  webchat: ["access", "agent", "apps", "chats", "participation"],
};

/**
 * Contexts a context's tests may import beyond ALLOWED_IMPORTS. A connection's
 * test drives it end to end, through the Chats port that admits its messages
 * and the People repository its setup reads.
 */
const TEST_ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  connections: ["chats", "participation", "people"],
};

function isTest(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

/** Why a context never imports another, where the model says more than the graph. */
const REASONS: Record<string, string> = {
  "agent-never-imports-apps":
    "The agent context defines the extension points and Apps supplies them, so no file in agent/ imports apps/. An adapter that reads what an app ships lives in apps/ and implements the agent context's interface.",
  "agent-never-imports-connections":
    "An agent never knows which connection carries its chat, so no file in agent/ imports connections/. What an agent needs from a chat reaches it through Chats.",
  "apps-never-imports-favors":
    "A favor request exists to run an app action, so Favors depends on Apps and no file in apps/ imports favors/.",
  "favors-never-imports-agent":
    "A favor request runs an app action for a visitor, and no agent takes part in it, so no file in favors/ imports agent/.",
  "favors-never-imports-chats":
    "A favor request never names a chat or an account, so no file in favors/ imports chats/.",
  "favors-never-imports-connections":
    "A favor request never names a connection, so no file in favors/ imports connections/.",
  "favors-never-imports-people":
    "A favor request knows its visitor by their Rome Cloud account, not as a person, so no file in favors/ imports people/.",
  "connections-never-imports-chats":
    "A connection only translates what the platform says into its own Message. Chats records it and decides who said it, so no file in connections/ imports chats/.",
  "connections-never-imports-people":
    "A connection names a sender by the platform's account id. People decides who that is, so no file in connections/ imports people/.",
  "connections-never-imports-participation":
    "A connection never decides whom a message addresses or whether Rome answers it. Participation does, for each of Rome's accounts, so no file in connections/ imports participation/.",
  "connections-never-imports-identity":
    "A connection hands on what the platform said and never knows an account code exists or whom an account belongs to, so no file in connections/ imports identity/, the account code's shape and its steps included.",
  "connections-never-imports-webchat":
    "The dashboard is Rome's own chat, not a connection, so no file in connections/ imports webchat/.",
  "desktops-never-imports-agent":
    "Desktops says which machines Rome can reach and what it can do on them, whoever asks, so no file in desktops/ imports agent/.",
  "desktops-never-imports-chats":
    "Desktops never names a chat or an account, so no file in desktops/ imports chats/.",
  "desktops-never-imports-connections":
    "Desktops never names a connection, so no file in desktops/ imports connections/.",
  "desktops-never-imports-people":
    "Desktops never names a person or an account, so no file in desktops/ imports people/.",
  "desktops-never-imports-apps":
    "Desktops answers whichever app asks and never knows which one it is, so no file in desktops/ imports apps/.",
  "desktops-never-imports-favors":
    "Desktops never knows what a favor asked for, so no file in desktops/ imports favors/.",
  "desktops-never-imports-participation":
    "Desktops never knows what woke an agent or where it speaks, so no file in desktops/ imports participation/.",
  "identity-never-imports-access":
    "Identity says which person an account belongs to. Access's steps on members ask Identity who a person is, so no file in identity/ imports access/.",
  "identity-never-imports-people":
    "Identity says who a person is, whoever they are to the guardian. People grades that relationship, so no file in identity/ imports people/.",
  "instance-never-imports-agent":
    "Instance says which Rome this is and whether it is healthy, whoever runs on it, so no file in instance/ imports agent/.",
  "instance-never-imports-apps":
    "Apps read the instance's identity and health, never the other way round, so no file in instance/ imports apps/.",
  "instance-never-imports-chats":
    "Instance never names a chat or an account, so no file in instance/ imports chats/.",
  "instance-never-imports-connections":
    "A connection asks Instance who this Rome is when it goes through Rome Cloud. Instance never names a connection, so no file in instance/ imports connections/.",
  "instance-never-imports-desktops":
    "Desktops asks Instance for this Rome's identity to reach a machine, never the other way round, so no file in instance/ imports desktops/.",
  "instance-never-imports-favors":
    "Favors asks Rome Cloud on the instance's behalf through Instance, never the other way round, so no file in instance/ imports favors/.",
  "instance-never-imports-participation":
    "Instance never decides when an agent takes part in a chat, so no file in instance/ imports participation/.",
  "instance-never-imports-people":
    "Instance never names a person, so no file in instance/ imports people/.",
  "instance-never-imports-access":
    "Access asks Instance which Rome Cloud this Rome belongs to, so no file in instance/ imports access/.",
};

function contextOf(path: string): string {
  return path.split("/")[0];
}

// Apps is what an app is and how it runs, and the contexts that use apps build
// on it. Handing an app what another context offers is App host's job.
const APPS_STAYS_FOUNDATIONAL =
  "Apps defines what an app receives and runs it, and App host fills that in from the other contexts, so no file in apps/ imports";

function describe(from: string, to: string, name: string): string {
  if (REASONS[name]) return REASONS[name];
  if (to === "app-host") {
    return `App host builds an app's ctx from every context, and only index.ts and the worker's entry point start it, so no file in ${from}/ imports app-host/.`;
  }
  if (from === "apps") return `${APPS_STAYS_FOUNDATIONAL} ${to}/.`;
  const allowed = ALLOWED_IMPORTS[from];
  const may = allowed.length > 0 ? allowed.map((c) => `${c}/`).join(", ") : "no other context";
  return `${from}/ may import only ${may}, so no file in ${from}/ imports ${to}/.`;
}

/** Every context folder directly under src/. */
export const contexts = Object.keys(ALLOWED_IMPORTS);

export const contextRules: ImportRule[] = contexts.flatMap((from) =>
  contexts
    .filter((to) => to !== from && !ALLOWED_IMPORTS[from].includes(to))
    .map((to) => {
      const name = `${from}-never-imports-${to}`;
      return {
        name,
        description: describe(from, to, name),
        rejects: (imp) =>
          imp.kind === "file" &&
          contextOf(imp.from) === from &&
          contextOf(imp.to) === to &&
          !(isTest(imp.from) && TEST_ALLOWED_IMPORTS[from]?.includes(to)),
      } satisfies ImportRule;
    }),
);

const CHANNEL_MESSAGE = "chats/connected-accounts/channel-message.ts";

/** Rules inside contexts, where one module is the only way through. */
export const contextEntryRules: ImportRule[] = [
  {
    name: "channel-message-built-in-one-place",
    description:
      "What an app receives is built from a connection's Message at one point, so only chats/connected-accounts/connection-ports.ts imports channel-message.ts. Tests and the test kit in test/ may convert too.",
    rejects: (imp) =>
      imp.kind === "file" &&
      imp.to === CHANNEL_MESSAGE &&
      imp.from !== "chats/connected-accounts/connection-ports.ts" &&
      !isTest(imp.from) &&
      !imp.from.startsWith("test/"),
  },
  {
    name: "connections-declare-chat-rules-only",
    description:
      "Core owns the chat rules: it stores them and the wake gate runs them. A kind of connection only declares which rules its chats offer, so a file in connections/ imports nothing of chat-settings/ but rules.ts. Tests may, to drive the service. Vocabulary: docs/domains/chats.md#chat-rule.",
    rejects: (imp) =>
      imp.kind === "file" &&
      imp.from.startsWith("connections/") &&
      imp.to.startsWith("chat-settings/") &&
      imp.to !== "chat-settings/rules.ts" &&
      !isTest(imp.from),
  },
];

/**
 * Files in connections/ that still import Chats, People or Participation,
 * with the files they import there, until ZHA-230 moves the work out.
 */
const CONNECTIONS_PENDING: ReadonlyArray<{ from: string; to: readonly string[]; why: string }> = [
  {
    from: "connections/app-chats.ts",
    to: [
      "chats/storage/message.ts",
      "chats/connected-accounts/connected-account.ts",
      "chats/storage/chat.ts",
      "chats/storage/chat-repository.ts",
      "chats/storage/message-repository.ts",
      "chats/storage/place.ts",
    ],
    why: "Listing an app's chats reads Chats' storage, until it moves to Chats.",
  },
  {
    from: "connections/channel-chat.ts",
    to: ["chats/storage/chat-repository.ts", "chats/storage/place.ts"],
    why: "Finding a connection's chat reads Chats' storage, until it moves to Chats.",
  },
  {
    from: "connections/chat-adapter.ts",
    to: ["chats/storage/chat.ts", "participation/conversation-buffer.ts", "chats/storage/place.ts"],
    why: "The chat adapter reads Chats' storage and Participation's buffer, until it moves to Chats.",
  },
  {
    from: "connections/inbound-recording.ts",
    to: [
      "chats/storage/chat-repository.ts",
      "chats/storage/events.ts",
      "chats/storage/message.ts",
      "chats/storage/message-repository.ts",
      "chats/storage/place.ts",
    ],
    why: "Recording a message heard is Chats' work, until it moves to Chats.",
  },
  {
    from: "connections/recorded-sends.ts",
    to: [
      "chats/connected-accounts/connected-account.ts",
      "chats/storage/chat-repository.ts",
      "chats/storage/message-repository.ts",
      "chats/storage/place.ts",
      "chats/storage/message.ts",
    ],
    why: "Recording a message sent is Chats' work, until it moves to Chats.",
  },
  {
    from: "connections/send.ts",
    to: [
      "chats/connected-accounts/connected-account.ts",
      "chats/send.ts",
      "chats/place.ts",
      "chats/storage/chat-repository.ts",
      "chats/storage/message-repository.ts",
      "chats/storage/place.ts",
    ],
    why: "Sending records the message in its chat, until recording moves to Chats.",
  },
  {
    from: "connections/speaker-messages.ts",
    to: ["chats/storage/message.ts", "chats/storage/message-repository.ts"],
    why: "Reading who spoke reads Chats' storage, until it moves to Chats.",
  },
  {
    from: "connections/outbound/send-refusals.ts",
    to: ["chats/widget-text.ts"],
    why: "A refused widget is sent as text written by Chats, until the fallback moves to Chats.",
  },
  {
    from: "connections/kinds/feishu/feishu.ts",
    to: ["chats/connected-accounts/account-agents.ts", "participation/mention-only.ts"],
    why: "Feishu still reads a chat's agent and its mention-only rule, until those move up.",
  },
];

/** Crossings that remain until their ticket lands. */
export const contextCrossings: ListedCrossing[] = [
  ...CONNECTIONS_PENDING.flatMap(({ from, to, why }) =>
    to.map((target) => ({
      rule: `connections-never-imports-${contextOf(target)}`,
      from,
      to: target,
      ticket: "ZHA-230",
      why,
    })),
  ),
  {
    rule: "instance-never-imports-relay",
    from: "instance/diagnostics.ts",
    to: "relay/settings.ts",
    ticket: "ZHA-169",
    why: "The diagnostics report says whether the relay is set up, until the report gets each context's status from that context.",
  },
];
