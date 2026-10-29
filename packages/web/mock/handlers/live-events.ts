import { ws } from "msw";

import { AI_TOOLS_STATUS_TOPIC } from "@rome/api-types/live-events";
import { mockAiToolsStatus, subscribeMockAiToolsStatus } from "./settings";

const liveEvents = ws.link(/\/ws\/events$/);

export const liveEventsHandlers = [
  liveEvents.addEventListener("connection", ({ client }) => {
    let unsubscribe: (() => void) | undefined;
    client.addEventListener("close", () => unsubscribe?.());
    client.addEventListener("message", (event) => {
      let message: { type?: unknown; topic?: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "unsubscribe" && message.topic === AI_TOOLS_STATUS_TOPIC) {
        unsubscribe?.();
        unsubscribe = undefined;
      }
      if (message.type === "subscribe" && typeof message.topic === "string") {
        client.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
        if (message.topic === AI_TOOLS_STATUS_TOPIC && !unsubscribe) {
          const send = () =>
            client.send(
              JSON.stringify({
                type: "event",
                topic: AI_TOOLS_STATUS_TOPIC,
                event: "status",
                data: mockAiToolsStatus(),
              }),
            );
          send();
          unsubscribe = subscribeMockAiToolsStatus(send);
        }
      }
    });
  }),
];
