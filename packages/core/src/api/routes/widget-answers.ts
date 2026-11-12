import { isWidgetAppPath } from "@rome-os/app-runtime";
import { Hono } from "hono";
import type { WebChatRepository } from "../../webchat/repository.js";

/** The events that answer the interaction the agent waits on, not the widget's app. */
const ANSWER_EVENTS = new Set(["rome:answer", "rome:dismiss"]);

/** A widget as a chat stores it: its app, its components, and whether the agent waits on it. */
interface StoredWidget {
  appId: string;
  components: unknown[];
  waits: boolean;
}

export interface WidgetAnswerDeps {
  webchatRepo: Pick<WebChatRepository, "getMessages">;
  /** Hands a request to Rome's own API, as if the caller had sent it there.
   *  `env` is the incoming request's, so the caller resolves the same way. */
  forward: (request: Request, env: unknown) => Response | Promise<Response>;
}

/**
 * Where a widget is answered. A client (the web dashboard or the iOS app)
 * sends every press on a widget's button here, and core decides what it means:
 * `rome:answer` and `rome:dismiss` answer the interaction the agent waits on,
 * as a turn in the chat; any other event calls the widget's app at
 * `/api/apps/<app id>/<event>`. Core accepts only an event a button on the
 * stored widget declares, so an answer reaches nothing the widget does not name.
 */
export function widgetAnswerRoutes(deps: WidgetAnswerDeps): Hono {
  const app = new Hono();

  app.post("/chat/sessions/:id/widgets/:toolUseId/answers", async (c) => {
    const sessionId = c.req.param("id");
    const toolUseId = c.req.param("toolUseId");
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      context?: unknown;
      turn?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const context = isObject(body?.context) ? body.context : {};

    const widget = findWidget(await deps.webchatRepo.getMessages(sessionId), toolUseId);
    if (!widget) return c.json({ error: "No widget with this id in this chat" }, 404);
    if (!eventNames(widget.components).has(name)) {
      return c.json({ error: "This widget has no button for that event" }, 400);
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
      return to(`/api/chat/sessions/${encodeURIComponent(sessionId)}/turns`, {
        ...turn,
        parts: [{ type: "interaction_result", toolUseId, output }],
      });
    }
    if (!isWidgetAppPath(name)) return c.json({ error: "The event is not a path in the app" }, 400);
    return to(`/api/apps/${encodeURIComponent(widget.appId)}/${name}`, context);
  });

  return app;
}

/** The widget with `toolUseId` in the chat, the latest when a turn reused the id. */
function findWidget(
  messages: readonly { role: string; content: string }[],
  toolUseId: string,
): StoredWidget | null {
  let found: StoredWidget | null = null;
  for (const message of messages) {
    let parts: unknown;
    try {
      parts = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (!Array.isArray(parts)) continue;
    for (const part of parts as Record<string, unknown>[]) {
      if (!isObject(part) || part.toolUseId !== toolUseId || typeof part.appId !== "string") {
        continue;
      }
      const ui =
        part.type === "widget"
          ? part.ui
          : part.type === "pending_interaction" && isObject(part.render)
            ? part.render.ui
            : undefined;
      if (isObject(ui) && Array.isArray(ui.components)) {
        found = {
          appId: part.appId,
          components: ui.components,
          waits: part.type === "pending_interaction",
        };
      }
    }
  }
  return found;
}

/** Every event a button on the widget names. */
function eventNames(components: readonly unknown[]): Set<string> {
  const names = new Set<string>();
  for (const component of components) {
    if (!isObject(component) || component.component !== "Button") continue;
    const event = isObject(component.action) ? component.action.event : undefined;
    if (isObject(event) && typeof event.name === "string") names.add(event.name);
  }
  return names;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
