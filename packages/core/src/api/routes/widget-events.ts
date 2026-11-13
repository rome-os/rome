import { isWidgetAppPath } from "@rome-os/app-runtime";
import { Hono } from "hono";
import { currentChatOwner } from "../../access/session-actor.js";
import type { WebChatRepository } from "../../webchat/repository.js";
import { canOpenChat } from "../../webchat/privacy.js";
import { getExternalRequestOrigin } from "../../lib/request-origin.js";

/** What core's own widget makes of one of its events: the output that answers
 *  the agent waiting on it. */
type CoreHandler = (context: Record<string, unknown>) => Record<string, unknown>;

/**
 * The widgets core owns, by kind, and how each handles its events. The question
 * card's Send answers the agent with what was picked and typed, and its Dismiss
 * declines. Core turns the answer into what the agent reads when the turn starts.
 */
const CORE_WIDGETS: Record<string, Record<string, CoreHandler>> = {
  "question-card": {
    send: (context) => context,
    dismiss: () => ({ dismissed: true }),
  },
};

/** Set on the env of a turn the widget route starts, which a client cannot
 *  set: only this route answers an app's widget the agent waits on. */
const WIDGET_EVENT = Symbol.for("rome.widget-event");

/** Whether a request came through the widget route, from `c.env`. */
export function cameThroughWidgetEvent(env: unknown): boolean {
  return isObject(env) && (env as Record<symbol, unknown>)[WIDGET_EVENT] === true;
}

/** A link a client may open: https, or a page of this instance. */
function vetLink(link: unknown, origin: string): string | undefined {
  if (typeof link !== "string") return undefined;
  try {
    const url = new URL(link, origin);
    return url.protocol === "https:" || url.origin === origin ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The names a question card stored before its events were its own. */
const STORED_EVENT_NAMES: Record<string, string> = {
  "rome:answer": "send",
  "rome:dismiss": "dismiss",
};

/** A widget as a chat stores it: one message whose one part is the widget. */
interface StoredWidget {
  chatId: string;
  toolUseId: string;
  appId: string;
  /** The kind of a widget core owns, such as `question-card`. */
  componentId?: string;
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
 * declares the event, then hands the event to the widget's owner: an app's
 * widget calls the app at `/api/apps/<app id>/<event>`; a widget core owns,
 * such as the question card, is handled here, and its answer becomes a turn in
 * the chat. The client only sends the event; it never decides what it means.
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
        { ...(isObject(c.env) ? c.env : {}), [WIDGET_EVENT]: true },
      );

    if (widget.appId === "core") {
      const handle = CORE_WIDGETS[widget.componentId ?? ""]?.[STORED_EVENT_NAMES[name] ?? name];
      if (!handle) return c.json({ error: "This widget declares no such event" }, 400);
      if (!widget.waits) return c.json({ error: "The agent does not wait on this widget" }, 400);
      return answer(to, widget, widgetId, handle(context), body?.turn);
    }
    if (!isWidgetAppPath(name)) return c.json({ error: "The event is not a path in the app" }, 400);
    const reply = await to(`/api/apps/${encodeURIComponent(widget.appId)}/${name}`, context);
    if (!reply.ok) return reply;
    const said = (await reply.json().catch(() => null)) as {
      answer?: unknown;
      open?: unknown;
    } | null;
    // An app's widget the agent waits on answers it when the app's reply says
    // so; the answer is labelled as the app's, never as the guardian's words.
    if (widget.waits && said?.answer !== undefined) {
      return answer(to, widget, widgetId, { from: widget.appId, value: said.answer }, body?.turn);
    }
    // Core writes what the client reads: whether the agent was answered and a
    // link to open, never a field of the app's own.
    // The origin the guardian reached Rome at, which a relative link joins.
    const open = vetLink(said?.open, getExternalRequestOrigin(c.req.raw).origin);
    return c.json(open ? { open } : {});
  });

  /**
   * Answers the agent waiting on `widget` with `output`, as a turn in its chat
   * that carries the chat's own turn fields (persona, reasoning effort,
   * workspace), which the client sends with every event. The reply says
   * `answered: true`, so a client locks the widget without knowing why.
   */
  async function answer(
    to: (path: string, json: unknown) => Response | Promise<Response>,
    widget: StoredWidget,
    widgetId: string,
    output: unknown,
    turnFields: unknown,
  ) {
    const turn = isObject(turnFields) ? turnFields : {};
    const res = await to(`/api/chat/sessions/${encodeURIComponent(widget.chatId)}/turns`, {
      ...turn,
      // The message names the card pressed: a later card in the chat can
      // reuse its tool-use id.
      parts: [
        { type: "interaction_result", toolUseId: widget.toolUseId, messageId: widgetId, output },
      ],
    });
    if (!res.ok) return res;
    const turnReply = await res.json().catch(() => ({}));
    return Response.json(
      { ...(isObject(turnReply) ? turnReply : {}), answered: true },
      { status: res.status },
    );
  }

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
    componentId:
      isObject(part.render) && typeof part.render.componentId === "string"
        ? part.render.componentId
        : undefined,
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
