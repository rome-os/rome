import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

// Rome Cloud agent messaging (amantru/rome-cloud#137). Cloud gives this
// instance an endpoint that dots and other agents can message, stores messages
// for it until the instance acknowledges them, and sends as it. The instance
// token decides the account and endpoint. Every endpoint is known by its
// `endpointId`, which never changes; its name is a label its owner can change,
// and two endpoints can share one.

/** An endpoint as Cloud names it: its stable id and its current name. */
export interface AgentEndpointRef {
  endpointId: string;
  name: string;
}

/** A message as Cloud delivers it. Cloud sets `messageId`, `from`, and `sentAt`. */
export interface AgentMessageEnvelope {
  messageId: string;
  /** `endpointId` is what a reply goes to, and null once the sender endpoint
   *  is removed. `name` is its name now, or when it sent this if removed.
   *  `account` is its owner's handle, and `sameAccount` is Cloud's statement
   *  that the sender is in this Rome's account. */
  from: {
    endpointId: string | null;
    name: string;
    kind: "dot" | "rome";
    account: string;
    sameAccount: boolean;
  };
  to: AgentEndpointRef;
  sentAt: string;
  text: string;
  data: Record<string, unknown> | null;
  inReplyTo: string | null;
  hop: number;
}

export interface AgentEndpointSummary extends AgentEndpointRef {
  kind: "dot" | "rome";
  /** The owner's handle. */
  account: string;
  /** False while a dot's pairing waits for the person's confirmation. */
  ready: boolean;
  /** False for an endpoint of a linked account. */
  sameAccount: boolean;
}

/** How an agent reads where its name stands in for a person's: its name, its
 *  kind, and for another account's agent, that account's handle. */
export function agentLabel(agent: {
  name: string;
  kind: string;
  account: string;
  sameAccount: boolean;
}): string {
  return agent.sameAccount
    ? `${agent.name} (${agent.kind})`
    : `${agent.name} (@${agent.account}'s ${agent.kind})`;
}

/** Cloud's refusal for an endpoint it will not deliver to, the same for one
 *  that does not exist and one no link allows, so a stranger cannot learn
 *  which endpoints exist. */
export function isNotReachable(err: unknown): boolean {
  return err instanceof AgentMessagingError && err.code === "not_reachable";
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
  endpoints(): Promise<{ self: AgentEndpointRef; endpoints: AgentEndpointSummary[] }>;
  /** Messages waiting for this instance, oldest first, until acknowledged. */
  poll(): Promise<{ self: AgentEndpointRef; messages: AgentMessageEnvelope[] }>;
  acknowledge(messageIds: string[]): Promise<void>;
  /** Sends to an endpoint by its id. */
  send(input: {
    to: string;
    text: string;
    inReplyTo?: string;
  }): Promise<{ messageId: string; to: AgentEndpointRef }>;
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
