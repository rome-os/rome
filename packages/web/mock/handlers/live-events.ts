import { ws } from "msw";

// Acknowledges every live-events subscription and then stays silent, like the
// held-open SSE mocks: the fixtures change only through this mock's own
// mutations, which invalidate their queries directly.
const liveEvents = ws.link(/\/ws\/events$/);

export const liveEventsHandlers = [
  liveEvents.addEventListener("connection", ({ client }) => {
    client.addEventListener("message", (event) => {
      let message: { type?: unknown; topic?: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.type === "subscribe" && typeof message.topic === "string") {
        client.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
      }
    });
  }),
];
