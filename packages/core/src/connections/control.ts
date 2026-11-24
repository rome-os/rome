// What agents do with connections through the system app's connection
// actions: read what is connected and whether it works, ask the guardian to
// connect a service, and disconnect one. The Connections page reads the same
// projection (`GET /api/connections`) and disconnects through the same
// operation (disconnect.ts); the connect card is `connect_account`'s
// (connect-card.ts), whose Connect starts the page's setup. The main process
// runs these operations; an action worker reaches them over the
// `connections.control` worker call (app-host/connection-calls.ts).
// Vocabulary: docs/domains/connections.md.

import type { PendingInteraction, PreviewPayload } from "@rome-os/app-runtime";
import { actionExecutionContext, type ActionExecutionStore } from "../apps/actions/context.js";
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

/** The turn an operation runs for: who it acts for, who can read it, and where. */
export type ConnectionTurn = Pick<ActionExecutionStore, "actor" | "audience" | "channelContext">;

export type ConnectionControlResult =
  | { status: "ok"; data: unknown }
  | { status: "error"; error: string }
  | { status: "pending_interaction"; interaction: PendingInteraction };

export const CONNECTION_CONTROL_OPS = [
  "read",
  "connect",
  "previewDisconnect",
  "disconnect",
] as const;
export type ConnectionControlOp = (typeof CONNECTION_CONTROL_OPS)[number];

/** Each operation, for the turn that asks for it. */
export type ConnectionOperations = Record<
  ConnectionControlOp,
  (input: unknown, turn: ConnectionTurn) => Promise<ConnectionControlResult>
>;

/** The operations as the system app's actions reach them: the main process's
 * own, or a worker's call to it. */
export interface ConnectionControlService {
  call(op: ConnectionControlOp, input: unknown): Promise<ConnectionControlResult>;
}

/** The turn of the running action. */
export function runningConnectionTurn(): ConnectionTurn {
  const store = actionExecutionContext.getStore();
  return {
    ...(store?.actor ? { actor: store.actor } : {}),
    ...(store?.audience ? { audience: store.audience } : {}),
    ...(store?.channelContext ? { channelContext: store.channelContext } : {}),
  };
}

/** Runs each operation for the turn of the action that calls it. */
export function connectionControlService(
  operations: ConnectionOperations,
): ConnectionControlService {
  return { call: (op, input) => operations[op](input, runningConnectionTurn()) };
}

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

export interface ConnectionOperationDeps {
  /** The connections, as `GET /api/connections` lists them. */
  connections: () => Promise<ListedConnection[]>;
  registry: Pick<ConnectionRegistry, "all" | "getDescriptor" | "disconnect" | "remove">;
  /** Whether the turn works for the guardian: the routine reads' rule
   *  (routines/turn-access.ts `turnWorksForGuardian`). */
  worksForGuardian: (turn: ConnectionTurn) => Promise<boolean>;
  /** Why the turn may not change what the guardian alone changes: the routine
   *  writes' rule (routines/turn-access.ts `changeRefusalReason`). */
  changeRefusalReason: (turn: ConnectionTurn) => "not_private" | "not_guardian" | null;
  /** The device kinds devices reported, which the connect card connects too. */
  deviceKinds?: () => readonly DeviceKind[];
  /** How a device kind stands, on the device the guardian asks from alone when there is one. */
  deviceState?: (kind: string, askingDeviceId: string | undefined) => DeviceKindState | undefined;
  /** The guardian's language, which a device card's words follow. */
  guardianLanguage?: () => Promise<string | null>;
}

const READ_REFUSED = {
  status: "error" as const,
  error:
    "connections_guardian_only: Only the guardian's agents can read Rome's connections, and this turn does not work for the guardian. Say so, and that the guardian can ask in their own chat.",
};

const DISCONNECT_REFUSED = {
  not_private:
    "connection_private_only: This chat is not private with the guardian, so no connection can be disconnected from it. Say so, and that they can ask in their own chat.",
  not_guardian:
    "connection_needs_guardian: Only the guardian's own message can disconnect a connection, and this turn did not start from one. Disconnect nothing; tell them what you would disconnect, so they can ask for it themselves.",
} as const;

const CONNECT_REFUSED = {
  not_private:
    "connection_private_only: This chat is not private with the guardian, so no connect card can be shown in it. Say so, and that they can connect it in their own chat or in Settings › Connections.",
  not_guardian:
    "connection_needs_guardian: Only the guardian's own message can ask to connect a service, and this turn did not start from one. Show no card; tell them what you would connect, so they can ask for it themselves.",
} as const;

/** The connection operations, over the Connections page's projection and the registry. */
export function connectionOperations(deps: ConnectionOperationDeps): ConnectionOperations {
  return {
    read: async (_input, turn) => {
      if (!(await deps.worksForGuardian(turn))) return READ_REFUSED;
      const listed = await deps.connections();
      return {
        status: "ok",
        data: {
          connections: listed.filter((c) => c.id !== null).map(forAgent),
          notConnected: listed
            .filter((c) => c.id === null)
            .map((c) => ({ kind: c.connectionKind, name: c.kindLabel })),
        },
      };
    },

    // The same card `connect_account` shows, from the same request. Where
    // the chat draws no card, the agent asks the guardian in a message.
    connect: async (input, turn) => {
      const refused = deps.changeRefusalReason(turn);
      if (refused) return { status: "error", error: CONNECT_REFUSED[refused] };
      const askingDeviceId = askingDeviceOf(turn.channelContext);
      const request = await connectCardRequest(input, {
        devices: deps.deviceKinds?.() ?? [],
        deviceState: (kind) => deps.deviceState?.(kind, askingDeviceId),
        language: deps.guardianLanguage,
      });
      if (request.status === "refused") return { status: "error", error: request.error };
      if (request.status === "answer") return { status: "ok", data: { message: request.message } };
      // `builtin` marks the card as core's own, which the chat draws only
      // from `connect_account` or this action.
      const render = {
        kind: "inline",
        componentId: CONNECT_CARD_ID,
        props: request.props,
        builtin: true,
      } as PendingInteraction["render"];
      return {
        status: "pending_interaction",
        interaction: { appId: "core", promptText: request.ask, render },
      };
    },

    // The words of the approval card: shown to the guardian alone, so it
    // names the connection whoever asked.
    previewDisconnect: async (input) => {
      const connectionId = text(fieldsOf(input).connectionId);
      const found = (await deps.connections()).find((c) => c.id !== null && c.id === connectionId);
      if (!found) return notFound(connectionId);
      const account = accountName(found);
      const what = `${found.kindLabel}${account ? ` (${account})` : ""}`;
      const preview: PreviewPayload = {
        kind: "generic",
        title: `Disconnect ${what}`,
        summary: `Rome loses its access to ${what}. To use it again, you connect it again in Settings › Connections.`,
      };
      return { status: "ok", data: preview };
    },

    disconnect: async (input, turn) => {
      const refused = deps.changeRefusalReason(turn);
      if (refused) return { status: "error", error: DISCONNECT_REFUSED[refused] };
      const connectionId = text(fieldsOf(input).connectionId);
      if (!connectionId) return notFound(connectionId);
      const outcome = await disconnectConnection(deps.registry, connectionId);
      if (outcome.status === "not-found") return notFound(connectionId);
      const { connection, warning } = outcome;
      return {
        status: "ok",
        data: {
          connectionId: connection.id,
          kind: connection.connectionKind,
          name: deps.registry.getDescriptor(connection.connectionKind)?.label ?? connection.label,
          disconnected: true,
          ...(warning ? { warning } : {}),
        },
      };
    },
  };
}

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

function fieldsOf(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function notFound(connectionId: string) {
  return {
    status: "error" as const,
    error: connectionId
      ? `No connection found with id "${connectionId}". Use system:read_connections to find the right id.`
      : "Pass the connection's id as connectionId. Find it with system:read_connections.",
  };
}
