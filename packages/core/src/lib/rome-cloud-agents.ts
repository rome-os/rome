import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

// Rome Cloud agent messaging (amantru/rome-cloud#137). Cloud gives this
// instance an endpoint that dots and other agents in the same account can
// address, stores messages for it until the instance acknowledges them, and
// sends as it. The instance token decides the account and endpoint.

/** A message as Cloud delivers it. Cloud sets `messageId`, `from`, and `sentAt`. */
export interface AgentMessageEnvelope {
  messageId: string;
  /** `sameAccount` is Cloud's statement that the sender is in this Rome's
   *  account. An older Cloud omits it, and Rome then trusts no sender. */
  from: { endpoint: string; kind: "dot" | "rome"; sameAccount?: boolean };
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
