// WebChat connection integration. Channel contract: docs/architecture/channels.md.
//
// WebChat is the zero-grant case: access is bounded out-of-band
// by the guardian-gated web app (the Rome dashboard, itself behind guardian
// auth), so there is nothing to confer — `auth: {}` and the Talker is unlocked
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
// read/write `webchatRepo` directly and bypass `ProviderAdapter.onMessage`
// entirely (webchat skips message_handler). This descriptor's
// `onMessage`/`deliver` wiring exists only for interface parity; nothing
// drives it today (same as the pre-cutover `WebChatAdapter.onMessage`, which
// no caller ever registered a real consumer against either). See cross-stage
// notes for how the wire stage should source `getPort("webchat")`
// post-migration.

import { WebChatAdapter } from "../../channels/webchat.js";
import type { TalkFeatureMap, TalkFeatureName } from "@rome-os/app-runtime";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { ConnectionDescriptor, Talker } from "../types.js";
import { historyFeature, toInboundMessage, toMessageReceipt } from "./talk-features.js";

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
      talker: {
        needs: [] as const,
        // Webchat turns start from its own HTTP route, so its channel has no
        // inbound port for the channel-message hook to answer a second time.
        receives: false,
        build(): Talker {
          const adapter = new WebChatAdapter(deps.webchatRepo);

          return {
            start(deliver, _fault): void {
              adapter.onMessage(async (msg) => deliver(toInboundMessage(msg)));
              // WebChatAdapter.start() is a synchronous no-op (log only) that
              // never rejects — no fault wiring needed (see module doc).
              void adapter.start();
            },
            stop(): Promise<void> {
              return adapter.stop();
            },
            async send(conversationId, msg) {
              return toMessageReceipt(
                conversationId,
                await adapter.sendMessage(conversationId, conversationId, msg),
              );
            },
            feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null {
              const features: Partial<TalkFeatureMap> = { history: historyFeature(adapter) };
              return (features[name] as TalkFeatureMap[K] | undefined) ?? null;
            },
          };
        },
      },
    },
  };
}
