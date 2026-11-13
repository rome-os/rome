import { WIDGET_UI_HOST_EVENTS, isWidgetAppPath } from "@rome-os/app-runtime";
import { Hono } from "hono";
import { currentChatOwner } from "../../access/session-actor.js";
import type { WebChatRepository } from "../../webchat/repository.js";
import { canOpenChat } from "../../webchat/privacy.js";

/** The events that answer the agent waiting on a widget, not the widget's app. */
const ANSWER_EVENTS: ReadonlySet<string> = new Set(WIDGET_UI_HOST_EVENTS);

/** A widget as a chat stores it: one message whose one part is the widget. */
interface StoredWidget {
  chatId: string;
  toolUseId: string;
  appId: string;
  components: unknown[];
  waits: boolean;
}

export interface WidgetEventDeps {
  webchatRepo: Pick<WebChatRepository, "widgetMessage" | "getSession">;
  /** Hands a request to Rome's own API, as if the caller had sent it there.
   *  `env` is the incoming request's, so the caller resolves the same way. */
  forward: (request: Request, env: unknown) => Response | Promise<Response>;
  /** Whose chats the caller may open. */
  callerOwner?: () => Promise<string | null>;
}

/**
 * Where a client (the web dashboard or the iOS app) sends every event a widget
 * fires. A widget is a message of its own, so its id is the message's id.
 * Core finds it, checks that the caller may open its chat and that the widget
 * declares the event, then routes it: `rome:answer` and `rome:dismiss` answer
 * the agent waiting on the widget, as a turn in the chat; any other event calls
 * the widget's app at `/api/apps/<app id>/<event>`.
 */
export function widgetEventRoutes(deps: WidgetEventDeps): Hono {
  const app = new Hono();
  const callerOwner = deps.callerOwner ?? currentChatOwner;

  app.post("/chat/widgets/:id/events", async (c) => {
    const widgetId = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      context?: unknown;
      turn?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const context = isObject(body?.context) ? body.context : {};

    // The route checks the chat itself: it is under no chat's path, so no
    // other route's guard runs before it. Not found, to anyone who may not open it.
    // The chat and the widget come from one row, so the chat checked is the
    // chat whose widget is pressed.
    const message = await deps.webchatRepo.widgetMessage(widgetId);
    const owner = await callerOwner();
    if (
      !message ||
      !(await canOpenChat((id) => deps.webchatRepo.getSession(id), message.chatId, owner))
    ) {
      return c.json({ error: "No widget with this id" }, 404);
    }
    const widget = readWidget(message.chatId, message.content);
    if (!widget) return c.json({ error: "No widget with this id" }, 404);
    if (!eventNames(widget.components).has(name)) {
      return c.json({ error: "This widget declares no such event" }, 400);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const to = (path: string, json: unknown) =>
      deps.forward(
        new Request(new URL(path, c.req.url), {
          method: "POST",
          headers,
          body: JSON.stringify(json),
        }),
        c.env,
      );

    if (ANSWER_EVENTS.has(name)) {
      if (!widget.waits) return c.json({ error: "The agent does not wait on this widget" }, 400);
      const output = name === "rome:dismiss" ? { dismissed: true } : context;
      // The rest of the turn (persona, reasoning effort, workspace) is the
      // chat's, as the dashboard sends it with any other turn.
      const turn = isObject(body?.turn) ? body.turn : {};
      return to(`/api/chat/sessions/${encodeURIComponent(widget.chatId)}/turns`, {
        ...turn,
        // The message names the card pressed: a later card in the chat can
        // reuse its tool-use id.
        parts: [
          { type: "interaction_result", toolUseId: widget.toolUseId, messageId: widgetId, output },
        ],
      });
    }
    if (!isWidgetAppPath(name)) return c.json({ error: "The event is not a path in the app" }, 400);
    return to(`/api/apps/${encodeURIComponent(widget.appId)}/${name}`, context);
  });

  return app;
}

/** The widget a message holds, or null when it holds no widget. */
function readWidget(chatId: string, content: string | null): StoredWidget | null {
  let parts: unknown;
  try {
    parts = JSON.parse(content ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length !== 1) return null;
  const part = parts[0];
  if (!isObject(part) || typeof part.toolUseId !== "string" || typeof part.appId !== "string") {
    return null;
  }
  const ui =
    part.type === "widget"
      ? part.ui
      : part.type === "pending_interaction" && isObject(part.render)
        ? part.render.ui
        : undefined;
  if (!isObject(ui) || !Array.isArray(ui.components)) return null;
  return {
    chatId,
    toolUseId: part.toolUseId,
    appId: part.appId,
    components: ui.components,
    waits: part.type === "pending_interaction",
  };
}

/** Every event a component on the widget declares. */
function eventNames(components: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const component of components) {
    if (!isObject(component)) continue;
    const event = isObject(component.action) ? component.action.event : undefined;
    if (isObject(event) && typeof event.name === "string") names.add(event.name);
  }
  return names;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
