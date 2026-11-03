import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { z } from "zod";
import {
  APP_CATALOG_TOPIC,
  CHAT_STATUS_TOPIC,
  chatSessionTopicName,
} from "@rome/api-types/live-events";
import { LiveEventsClient } from "@/lib/live-events";
import {
  dispatchValidatedEvent,
  invokeObservedCallback,
  type SseErrorContext,
  type SseEventHandler,
  type SseEventHandlers,
  type UseSseEventsOptions,
  useSseEvents,
} from "./use-sse-events";

/** A live-events topic and the SSE route that serves the same events. */
export interface LiveTopic {
  topic: string;
  sseUrl: string;
}

export const chatStatusTopic: LiveTopic = {
  topic: CHAT_STATUS_TOPIC,
  sseUrl: "/api/chat/status/events",
};

export const appCatalogTopic: LiveTopic = {
  topic: APP_CATALOG_TOPIC,
  sseUrl: "/api/apps/events",
};

export function chatSessionTopic(sessionId: string): LiveTopic {
  return {
    topic: chatSessionTopicName(sessionId),
    sseUrl: `/api/chat/sessions/${encodeURIComponent(sessionId)}/events`,
  };
}

/** The tab's client. Tests provide their own. */
export const LiveEventsClientContext = createContext(new LiveEventsClient());

// EventSource's readyState values, so `onError` reads the same on both transports.
const CONNECTING: SseErrorContext["readyState"] = 0;
const CLOSED: SseErrorContext["readyState"] = 2;

/**
 * `useSseEvents` over the tab's shared live-events socket. Takes the same
 * handlers and options, with the same meaning:
 *  - `onReconnect` fires after the socket comes back and the topic is
 *    subscribed again, never on the first subscription.
 *  - `onError` sees `readyState` CONNECTING when the socket drops and CLOSED
 *    when the server refuses the topic. The client asks for a refused topic
 *    again only after the socket reconnects.
 *
 * When the socket never opens, or the browser has no WebSocket, the hook
 * streams `topic.sseUrl` through `useSseEvents` instead. If the socket opens
 * later, the hook moves back to it and `onReconnect` fires once the topic is
 * subscribed there.
 */
export function useLiveEvents<const Schemas extends Record<string, z.ZodType>>(
  topic: LiveTopic,
  handlers: SseEventHandlers<Schemas>,
  options?: UseSseEventsOptions,
): void {
  const client = useContext(LiveEventsClientContext);
  const transport = useSyncExternalStore(
    client.onTransportChange,
    client.getTransport,
    client.getTransport,
  );
  const enabled = options?.enabled ?? true;
  useSseEvents(topic.sseUrl, handlers, {
    ...options,
    enabled: enabled && transport === "fallback",
  });

  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const name = topic.topic;

  // Stays subscribed on the fallback too, so the client can resync this topic
  // when the socket comes back.
  useEffect(() => {
    if (!enabled) return;
    const reportError = (readyState: SseErrorContext["readyState"]) =>
      invokeObservedCallback(
        () => optionsRef.current?.onError?.({ readyState }),
        { rejected: "Live error handler rejected", failed: "Live error handler failed" },
        { topic: name, readyState },
      );
    return client.subscribe(name, {
      onEvent(eventName, data) {
        const current: Record<string, SseEventHandler> = handlersRef.current;
        if (!Object.hasOwn(current, eventName)) return;
        dispatchValidatedEvent(current[eventName], data, "Live", { topic: name, eventName });
      },
      onReconnect() {
        invokeObservedCallback(
          () => optionsRef.current?.onReconnect?.(),
          { rejected: "Live reconnect handler rejected", failed: "Live reconnect handler failed" },
          { topic: name },
        );
      },
      onDrop: () => reportError(CONNECTING),
      onRejected: () => reportError(CLOSED),
    });
  }, [client, name, enabled]);
}
