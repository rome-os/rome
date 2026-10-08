// WebChat connection integration. Channel contract: docs/architecture/channels.md.
//
// WebChat is the zero-grant case: access is bounded out-of-band
// by the guardian-gated web app (the Rome dashboard, itself behind guardian
// auth), so there is nothing to confer — `auth: {}` and the ChannelTransport is unlocked
// from birth (`needs: []`). It is also entirely in-process: no external
// transport, so it can never fault (`fault` is accepted but never called).
//
// The transport core — outbound persistence, inbound history read — is the
// existing `WebChatAdapter` (packages/core/src/channels/webchat.ts), wrapped
// here for the SAME reason every other channel is: `send`/`fetchHistory` stay
// reachable through the shared port map (the generic
// `send_message` / `fetch_channel_history` actions), post-migration.
//
// IMPORTANT — this does NOT change how webchat's OWN primary chat surface
// works: the `/api/webchat` routes (packages/core/src/api/routes/webchat.ts)
// read/write `webchatRepo` directly and bypass `WebChatAdapter.onInbound`
// entirely (webchat skips message_handler). This descriptor's
// `onInbound`/`deliver` wiring exists only for interface parity; nothing
// drives it today (no caller ever registered a real consumer against the
// adapter's inbound hook either). The transport already speaks the channel's
// record, so send and history pass through without a projection.

import { WebChatAdapter } from "../../channels/webchat.js";
import type { TransportFeatures } from "../types.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { ConnectionDescriptor, ChannelTransport } from "../types.js";
import { historyQueryLimit, historyWindowHours } from "./talk-features.js";

export interface WebchatDescriptorDeps {
  webchatRepo: WebChatRepository;
}

/**
 * Build the WebChat descriptor. `deps.webchatRepo` is threaded from index.ts
 * (the registry/bridge have no repo access) — the same repo the pre-cutover
 * `new WebChatAdapter(webchatRepo)` used.
 */
export function makeWebchatDescriptor(deps: WebchatDescriptorDeps): ConnectionDescriptor {
  return {
    service: "webchat",
    auth: {},
    capabilities: {
      transport: {
        needs: [] as const,
        // Webchat turns start from its own HTTP route, so its channel has no
        // inbound port for the channel-message hook to answer a second time.
        receives: false,
        history: true,
        build(): ChannelTransport {
          const adapter = new WebChatAdapter(deps.webchatRepo);

          const features: TransportFeatures = {
            history: {
              async query(input) {
                const messages = await adapter.fetchHistory(
                  input.conversationId ?? null,
                  historyWindowHours(input.since),
                );
                return messages.slice(0, historyQueryLimit(input.limit));
              },
            },
          };
          return {
            start(deliver, _fault): void {
              adapter.onInbound(async (msg) => deliver(msg));
              // WebChatAdapter.start() is a synchronous no-op (log only) that
              // never rejects — no fault wiring needed (see module doc).
              void adapter.start();
            },
            stop(): Promise<void> {
              return adapter.stop();
            },
            send(conversationId, msg) {
              return adapter.send(conversationId, msg);
            },
            ...features,
          };
        },
      },
    },
  };
}
