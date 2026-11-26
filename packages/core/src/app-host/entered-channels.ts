// The channels a `channel-message` hook gets, so what it hears straight from a
// channel is only what its recorded messages are: what someone let in said.
// Vocabulary: docs/domains/participation.md#entry.

import type { Channel } from "@rome-os/app-runtime";
import { enteredAs } from "../participation/entrance.js";

/** `channels` whose subscribers hear only the messages the entrance let in. */
export function enteredChannels<C extends Channel>(channels: readonly C[]): C[] {
  return channels.map((channel) => {
    const { inbound } = channel;
    if (!inbound) return channel;
    return {
      ...channel,
      inbound: {
        subscribe: (handler) =>
          inbound.subscribe(async (event) => {
            // The same line for a hook that subscribes to a channel itself
            // (sessions/messages-said.ts holds it for recorded messages).
            if (enteredAs(event)) await handler(event);
          }),
        get media() {
          return inbound.media;
        },
      },
    } as C;
  });
}
