import { ws } from "msw";

import { AI_TOOLS_STATUS_TOPIC } from "@rome/api-types/live-events";
import { subscribeMockAiToolsStatus } from "./settings";

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
          // Push whatever the status GET answers, so a page that overrides
          // that GET (as e2e fixtures do) gets the same state over the socket.
          const send = () =>
            void fetch("/api/ai-tools/status")
              .then((res) => res.json())
              .then((data) =>
                client.send(
                  JSON.stringify({
                    type: "event",
                    topic: AI_TOOLS_STATUS_TOPIC,
                    event: "status",
                    data,
                  }),
                ),
              )
              .catch(() => {});
          send();
          unsubscribe = subscribeMockAiToolsStatus(send);
        }
      }
    });
  }),
];
