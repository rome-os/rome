import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

// Rome Cloud agent messaging (amantru/rome-cloud#137). Cloud gives this
// instance an endpoint that dots and other agents can address, stores messages
// for it until the instance acknowledges them, and sends as it. The instance
// token decides the account and endpoint. Agents in this Rome's own account go
// by their bare endpoint name; an agent in a linked account goes by
// `@handle/endpoint`, so two accounts' `atlas` endpoints never meet.

/** A message as Cloud delivers it. Cloud sets `messageId`, `from`, and `sentAt`. */
export interface AgentMessageEnvelope {
  messageId: string;
  /** `sameAccount` is Cloud's statement that the sender is in this Rome's
   *  account. An older Cloud omits it, and Rome then trusts no sender.
   *  `endpoint` is what a reply goes to: the bare name in this Rome's own
   *  account, the full `@handle/endpoint` in a linked one, and the only field
   *  Rome keys a sender by. `account` and `address` are read only for
   *  whether they are present, as a sign the sender is in another account.
   *  `endpointId` never changes for an endpoint, and keeps its links on it
   *  through a rename (agents-identity.ts). It is null once the endpoint is
   *  removed, and an older Cloud omits it. */
  from: {
    endpoint: string;
    endpointId?: string | null;
    kind: "dot" | "rome";
    sameAccount?: boolean;
    account?: string;
    address?: string;
  };
  to: { endpoint: string };
  sentAt: string;
  text: string;
  data: Record<string, unknown> | null;
  inReplyTo: string | null;
  hop: number;
}

export interface AgentEndpointSummary {
  endpoint: string;
  kind: "dot" | "rome";
  /** False while a dot's pairing waits for the person's confirmation. */
  ready: boolean;
  /** The full `@handle/endpoint`. */
  address?: string;
  /** False for an endpoint of a linked account. Omitted by an older Cloud,
   *  which lists this Rome's own account only. */
  sameAccount?: boolean;
  /** Cloud's stable id for the endpoint. Omitted by an older Cloud. */
  endpointId?: string;
}

/**
 * The address Rome knows an agent by: the bare endpoint name in this Rome's own
 * account, `@handle/endpoint` in any other, as Cloud gives each in `endpoint`.
 * Null for a cross-account agent whose `endpoint` is not a full address, which
 * Rome can neither tell apart from its own agents nor answer.
 */
export function agentAddress(agent: {
  endpoint: string;
  sameAccount?: boolean;
  account?: string;
  address?: string;
}): string | null {
  if (
    agent.sameAccount === true ||
    (agent.sameAccount === undefined && !crossAccountShaped(agent))
  ) {
    return agent.endpoint;
  }
  return agentAddressAccount(agent.endpoint) !== null
    ? canonicalAgentAddress(agent.endpoint)
    : null;
}

/** An address as Cloud matches it: a handle ignores case, so `@Friend/atlas`
 *  is `@friend/atlas`, not a second account. */
export function canonicalAgentAddress(address: string): string {
  const handle = agentAddressAccount(address);
  return handle === null ? address : `@${handle.toLowerCase()}${address.slice(handle.length + 1)}`;
}

/** Whether an agent carries what only a linked account's agent does. An older
 *  Cloud omits `sameAccount` and every one of these, so an agent that carries
 *  any of them without `sameAccount` is not taken for one of this Rome's own. */
function crossAccountShaped(agent: { endpoint: string; account?: string; address?: string }) {
  return (
    agent.account !== undefined ||
    agent.address !== undefined ||
    agentAddressAccount(agent.endpoint) !== null
  );
}

/** The handle of a `@handle/endpoint` address, or null for a bare name. */
export function agentAddressAccount(address: string): string | null {
  return /^@([^@/\s]+)\/[^@/\s]+$/.exec(address)?.[1] ?? null;
}

/** Cloud's refusal for an address it will not deliver to: `unknown_endpoint`
 *  for a bare name with no endpoint in this account, and `not_reachable` for
 *  another account's address, the same for an agent that does not exist and
 *  one no link allows, so a stranger cannot learn which agents exist. */
export function isNotReachable(err: unknown): boolean {
  return err instanceof AgentMessagingError && err.code === "not_reachable";
}

export function isUndeliverable(err: unknown): boolean {
  return (
    err instanceof AgentMessagingError &&
    (err.code === "not_reachable" || err.code === "unknown_endpoint")
  );
}

export class AgentMessagingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AgentMessagingError";
  }
}

export interface AgentMessagingClient {
  /** This instance's endpoint and the others it can message. */
  endpoints(): Promise<{
    endpoint: string;
    /** This instance's full `@handle/endpoint`. An older Cloud omits it. */
    address?: string;
    endpoints: AgentEndpointSummary[];
  }>;
  /** Messages waiting for this instance, oldest first, until acknowledged. */
  poll(): Promise<{ endpoint: string; messages: AgentMessageEnvelope[] }>;
  acknowledge(messageIds: string[]): Promise<void>;
  send(input: {
    to: string;
    text: string;
    inReplyTo?: string;
  }): Promise<{ messageId: string; to: string }>;
}

export function createRomeCloudAgentsClient(
  options: { fetch?: typeof fetch } = {},
): AgentMessagingClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const token = getInstanceToken();
    if (!token) {
      throw new AgentMessagingError(
        "This Rome is not linked to Rome Cloud.",
        undefined,
        "no_token",
      );
    }
    const origin = getRomeCloudOrigin();
    if (!origin) {
      throw new AgentMessagingError("Rome Cloud is not configured.", undefined, "unconfigured");
    }
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Cache-Control": "no-store",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new AgentMessagingError(
        `Could not reach Rome Cloud: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        "unreachable",
      );
    }
    const payload = (await response.json().catch(() => null)) as
      | (T & { error?: string; message?: string })
      | null;
    if (!response.ok || payload === null) {
      throw new AgentMessagingError(
        payload?.message ?? `Rome Cloud ${path} failed (${response.status})`,
        response.status,
        payload?.error,
      );
    }
    return payload;
  }

  return {
    endpoints: () => request("/v1/agent-endpoints"),
    poll: () => request("/v1/agent-messages"),
    async acknowledge(messageIds) {
      if (messageIds.length > 0) await request("/v1/agent-messages/ack", { messageIds });
    },
    send: (input) => request("/v1/agent-messages", input),
  };
}
