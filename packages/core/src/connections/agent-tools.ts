// What agents do with connections: read what is connected and whether it
// works, ask the guardian to connect a service, and disconnect one. The
// Connections page reads the same projection (`GET /api/connections`) and
// disconnects through the same operation (disconnect.ts); the connect card is
// `connect_account`'s (connect-card.ts), whose Connect starts the page's
// setup. Vocabulary: docs/domains/connections.md. How a tool is declared:
// docs/concepts/actions.md#core-agent-tools.

import { z } from "zod";
import { agentToolsOf, card, toolError } from "../apps/actions/agent-tool.js";
import {
  CONNECT_CARD_ID,
  connectCardRequest,
  type DeviceKind,
  type DeviceKindState,
} from "./connect-card.js";
import { askingDeviceOf } from "./device/live-route.js";
import { disconnectConnection } from "./disconnect.js";
import type { ConnectionRegistry } from "./registry.js";
import type { CapabilityStatus, ConnectionState } from "./types.js";

/** A connection as `GET /api/connections` lists it, in the fields the agent
 *  reads. `id` is null for a kind the guardian never connected. */
export interface ListedConnection {
  id: string | null;
  connectionKind: string;
  label: string;
  kindLabel: string;
  state: ConnectionState | null;
  display: Record<
    string,
    { displayName: string | null; handle: string | null; email: string | null } | null
  >;
  capabilities: Record<"chat" | "act" | "watch", CapabilityStatus>;
  /** The agent linked to the connected account; null for none, absent for a
   *  kind whose accounts take no agent. */
  agent?: string | null;
}

export interface ConnectionToolDeps {
  /** The connections, as `GET /api/connections` lists them. */
  connections: () => Promise<ListedConnection[]>;
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "disconnect" | "remove">;
  /** The device kinds devices reported, which the connect card connects too. */
  deviceKinds?: () => readonly DeviceKind[];
  /** How a device kind stands, on the device the guardian asks from alone when there is one. */
  deviceState?: (kind: string, askingDeviceId: string | undefined) => DeviceKindState | undefined;
  /** The guardian's language, which a device card's words follow. */
  guardianLanguage?: () => Promise<string | null>;
}

const agentTool = agentToolsOf<ConnectionToolDeps>();

const connectionId = z.string().describe("The connection's id, from read_connections.");

export const readConnections = agentTool({
  name: "system:read_connections",
  description:
    "See what is connected to Rome and whether each connection works, with the account each one reaches. Use it when the guardian asks what is connected, whether a service such as GitHub, Slack or Google is connected, or why a connection is not working, and to find a connection's id before disconnecting it",
  sideEffects: "read-only",
  input: z.object({}),
  run: async (_input, { deps }) => {
    const listed = await deps.connections();
    return {
      connections: listed.filter((c) => c.id !== null).map(forAgent),
      notConnected: listed
        .filter((c) => c.id === null)
        .map((c) => ({ kind: c.connectionKind, name: c.kindLabel })),
    };
  },
});

export const connectService = agentTool({
  name: "system:connect_service",
  description:
    "Ask the guardian to connect a service to Rome, such as GitHub, Slack or Shopify, or to turn on something one of their devices offers, such as Apple Health on an iPhone, through a card in the chat they press to finish. Use it when the guardian asks to connect a service, or when a task needs a service that is not connected. Only in the guardian's private chat, in a turn their own message started. Check what is already connected with system:read_connections",
  sideEffects: "write",
  input: z.object({
    kind: z
      .string()
      .describe(
        'The kind of service to connect, such as "github", "slack" or "shopify", or a device kind such as "apple_health".',
      ),
  }),
  // The same card `connect_account` shows, from the same request. Where the
  // chat draws no card, the agent asks the guardian in a message.
  run: async (input, { deps, turn }) => {
    const askingDeviceId = askingDeviceOf(turn.channelContext);
    const request = await connectCardRequest(input, {
      devices: deps.deviceKinds?.() ?? [],
      deviceState: (kind) => deps.deviceState?.(kind, askingDeviceId),
      language: deps.guardianLanguage,
    });
    if (request.status === "refused") return toolError(request.error);
    if (request.status === "answer") return { message: request.message };
    return card({ componentId: CONNECT_CARD_ID, props: request.props, ask: request.ask });
  },
});

export const disconnectService = agentTool({
  name: "system:disconnect_service",
  description:
    "Disconnect one service from Rome, such as a GitHub account, a Slack workspace or a Google account, so Rome no longer has access to it. Use it when the guardian asks to disconnect, unlink or remove a connection. The guardian approves it on a card first. Only in the guardian's private chat, in a turn their own message started. Find the connection's id with system:read_connections",
  sideEffects: "write",
  input: z.object({ connectionId }),
  // Shown to the guardian alone, so it names the connection whoever asked.
  approval: async (input, { deps }) => {
    const id = input.connectionId.trim();
    const found = (await deps.connections()).find((c) => c.id !== null && c.id === id);
    if (!found) return { title: "Disconnect a connection", summary: notFound(id) };
    const account = accountName(found);
    const what = `${found.kindLabel}${account ? ` (${account})` : ""}`;
    return {
      title: `Disconnect ${what}`,
      summary: `Rome loses its access to ${what}. To use it again, you connect it again in Settings › Connections.`,
    };
  },
  run: async (input, { deps }) => {
    const id = input.connectionId.trim();
    if (!id) return toolError(notFound(id));
    const outcome = await disconnectConnection(deps.registry, id);
    if (outcome.status === "not-found") return toolError(notFound(id));
    const { connection, warning } = outcome;
    return {
      connectionId: connection.id,
      kind: connection.connectionKind,
      name: deps.registry.getDescriptor(connection.connectionKind)?.label ?? connection.label,
      disconnected: true,
      ...(warning ? { warning } : {}),
    };
  },
});

/** The Connections page's agent tools. */
export const connectionTools = [readConnections, connectService, disconnectService];

/** What the agent needs of one connection: what it is, whether it works,
 *  the account it reaches and what it lets Rome do. No credential is listed. */
function forAgent(c: ListedConnection) {
  const capabilities: Partial<Record<"chat" | "act" | "watch", CapabilityStatus["state"]>> = {};
  for (const name of ["chat", "act", "watch"] as const) {
    const state = c.capabilities[name]?.state;
    if (state && state !== "unsupported") capabilities[name] = state;
  }
  return {
    connectionId: c.id,
    kind: c.connectionKind,
    name: c.kindLabel,
    // The guardian's own name for it, when they renamed it.
    ...(c.label !== c.connectionKind && c.label !== c.kindLabel ? { label: c.label } : {}),
    // A connection a disconnect kept with no access has no state.
    state: c.state ?? "not_connected",
    account: {
      name: accountName(c),
      ...(c.agent !== undefined ? { agent: c.agent } : {}),
    },
    capabilities,
  };
}

function accountName(c: ListedConnection): string | null {
  for (const display of Object.values(c.display)) {
    const name = display?.displayName ?? display?.handle ?? display?.email;
    if (name) return name;
  }
  return null;
}

function notFound(connectionId: string): string {
  return connectionId
    ? `No connection found with id "${connectionId}". Use system:read_connections to find the right id.`
    : "Pass the connection's id as connectionId. Find it with system:read_connections.";
}
