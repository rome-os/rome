import type { NormalizedMessage, OutgoingMessage } from "./types.js";
import type { ChannelSendResult } from "@rome-os/app-runtime";

/**
 * The shape a provider's transport class takes inside its Connection
 * integration (connections/integrations/). It is not a port: the rest of Rome
 * reaches a channel through `Channel` (channel.ts), whose `send` and `inbound`
 * a Connection's Talk backs. Only an integration wrapping its transport, and
 * that transport's own tests, should name this. The registry exclusively owns
 * starting and stopping transports.
 */
export interface ProviderAdapter {
  readonly channelName: string;

  sendMessage(
    channelUserId: string,
    threadId: string,
    message: OutgoingMessage,
  ): Promise<ChannelSendResult | void>;

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void;
}
