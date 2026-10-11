import { useEffect, useRef } from "react";
import { z } from "zod";

export interface SseEventHandler<Schema extends z.ZodType = z.ZodType> {
  schema: Schema;
  fn: (value: z.output<Schema>) => void | Promise<void>;
}

export interface UseSseEventsOptions {
  enabled?: boolean;
  onReconnect?: () => void | Promise<void>;
  onError?: (context: SseErrorContext) => void | Promise<void>;
}

export interface SseErrorContext {
  readyState: EventSource["readyState"];
}

type SseEventHandlers<Schemas extends Record<string, z.ZodType>> = {
  [EventName in keyof Schemas]: SseEventHandler<Schemas[EventName]>;
};

interface ConnectionState {
  source: EventSource;
  listeners: Map<string, EventListener>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeObservedCallback(
  callback: () => void | Promise<void>,
  messages: { rejected: string; failed: string },
  context: Record<string, unknown>,
): void {
  try {
    const pending = callback();
    void Promise.resolve(pending).catch((error: unknown) => {
      console.error(messages.rejected, { ...context, error: errorMessage(error) });
    });
  } catch (error) {
    console.error(messages.failed, { ...context, error: errorMessage(error) });
  }
}

function invokeHandler<
  Schemas extends Record<string, z.ZodType>,
  EventName extends keyof Schemas & string,
>(
  handlersRef: { current: SseEventHandlers<Schemas> },
  url: string,
  eventName: EventName,
  event: MessageEvent<string>,
): void {
  const handler = handlersRef.current[eventName];

  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch {
    console.error("Invalid SSE event JSON", { url, eventName });
    return;
  }

  const result = handler.schema.safeParse(payload);
  if (!result.success) {
    console.error("Invalid SSE event payload", {
      url,
      eventName,
      issueCount: result.error.issues.length,
      issueCodes: result.error.issues.map(({ code }) => code),
    });
    return;
  }

  invokeObservedCallback(
    () => handler.fn(result.data),
    { rejected: "SSE event handler rejected", failed: "SSE event handler failed" },
    { url, eventName },
  );
}

function addEventListener<
  Schemas extends Record<string, z.ZodType>,
  EventName extends keyof Schemas & string,
>(
  state: ConnectionState,
  handlersRef: { current: SseEventHandlers<Schemas> },
  url: string,
  eventName: EventName,
): void {
  const listener = ((event: MessageEvent<string>) => {
    invokeHandler(handlersRef, url, eventName, event);
  }) as EventListener;
  state.listeners.set(eventName, listener);
  state.source.addEventListener(eventName, listener);
}

export function useSseEvents<const Schemas extends Record<string, z.ZodType>>(
  url: string,
  /** Event names are captured when the connection opens; keep this key set stable. */
  handlers: SseEventHandlers<Schemas>,
  options?: UseSseEventsOptions,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled || typeof EventSource !== "function") return;

    const source = new EventSource(url, { withCredentials: true });
    const state: ConnectionState = { source, listeners: new Map() };
    const activeHandlers = handlersRef.current;
    for (const eventName in activeHandlers) {
      addEventListener(state, handlersRef, url, eventName);
    }

    let hasOpened = false;
    const handleOpen = () => {
      if (!hasOpened) {
        hasOpened = true;
        return;
      }
      invokeObservedCallback(
        () => optionsRef.current?.onReconnect?.(),
        { rejected: "SSE reconnect handler rejected", failed: "SSE reconnect handler failed" },
        { url },
      );
    };
    source.addEventListener("open", handleOpen);
    const handleError = () => {
      const context: SseErrorContext = { readyState: source.readyState };
      invokeObservedCallback(
        () => optionsRef.current?.onError?.(context),
        { rejected: "SSE error handler rejected", failed: "SSE error handler failed" },
        { url, readyState: context.readyState },
      );
    };
    source.addEventListener("error", handleError);

    return () => {
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleError);
      for (const [eventName, listener] of state.listeners) {
        source.removeEventListener(eventName, listener);
      }
      state.listeners.clear();
      source.close();
    };
  }, [enabled, url]);
}
