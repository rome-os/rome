import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

// Rome Cloud agent messaging (amantru/rome-cloud#137). Cloud gives this
// instance an endpoint that dots and other agents can address, stores messages
// for it until the instance acknowledges them, and sends as it. The instance
// token decides the account and endpoint. Agents in this Rome's own account go
// by their bare endpoint name; an agent in a linked account goes by
// `@slug/endpoint`, so two accounts' `atlas` endpoints never meet.

/** A message as Cloud delivers it. Cloud sets `messageId`, `from`, and `sentAt`. */
export interface AgentMessageEnvelope {
  messageId: string;
  /** `sameAccount` is Cloud's statement that the sender is in this Rome's
   *  account. An older Cloud omits it, and Rome then trusts no sender.
   *  `account` is the sender account's slug; `endpoint` is always the bare
   *  name within it. */
  from: { endpoint: string; kind: "dot" | "rome"; sameAccount?: boolean; account?: string };
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
  /** Set to false, with the owner's slug in `account`, for an endpoint of a
   *  linked account. Omitted or true for this Rome's own account. */
  sameAccount?: boolean;
  account?: string;
}

/**
 * The address Rome knows an agent by: the bare endpoint name in this Rome's own
 * account, `@slug/endpoint` in any other. Null for a cross-account agent Cloud
 * named no account for, which Rome can neither tell apart from its own agents
 * nor answer.
 */
export function agentAddress(agent: {
  endpoint: string;
  sameAccount?: boolean;
  account?: string;
}): string | null {
  if (agent.sameAccount !== false) return agent.endpoint;
  if (!agent.account) return null;
  return `@${agent.account}/${agent.endpoint}`;
}

/** The slug of a `@slug/endpoint` address, or null for a bare name. */
export function agentAddressAccount(address: string): string | null {
  return /^@([^/\s]+)\/[^/\s]+$/.exec(address)?.[1] ?? null;
}

/** Cloud's refusal for an address it will not deliver to. It answers the same
 *  for an agent that does not exist and one whose owner has not allowed this
 *  Rome, so a stranger cannot learn which agents exist. */
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
  endpoints(): Promise<{ endpoint: string; endpoints: AgentEndpointSummary[] }>;
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
