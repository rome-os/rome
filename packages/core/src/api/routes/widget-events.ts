import { isWidgetAppPath } from "@rome-os/app-runtime";
import { Hono } from "hono";
import type { WebChatRepository } from "../../webchat/repository.js";
import { getExternalRequestOrigin } from "../../lib/request-origin.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { deviceConnectPath } from "../../connections/connect-card.js";
import type { SetupStartOutcome } from "../../connections/setup/start.js";
import { ASKING_DEVICE_HEADER, createLiveRoutes } from "../../connections/device/live-route.js";
import type { DeviceConnection } from "../../connections/device/repository.js";
import { DECLINED_LOCATION, sharedLocationAnswer } from "../../webchat/location-card.js";
import {
  DECLINE_LOCATION_EVENT,
  LOCATION_CARD_ID,
  SHARE_LOCATION_EVENT,
} from "@rome/api-types/location-card";

/** What core's own widget makes of one of its events: an answer for the agent
 *  waiting on it, a link for the client to open, or neither, which leaves the
 *  widget open. A Response is sent as it is, such as a refusal. */
type CoreReply = { answer: unknown } | { open: string } | { ok: true } | Response;

/** What a core handler may read while it decides. */
interface CoreIo {
  /** The connections, as `GET /api/connections` lists them to the caller. */
  connections(): Promise<ConnectionStatus[]>;
  /** The device connections, as `GET /api/device-connections` lists them to the caller. */
  deviceConnections(): Promise<DeviceConnection[]>;
  /** The origin the caller reached Rome at, for turning a path into a link. */
  origin: string;
  /** The props core stored with the widget, which a client cannot change. */
  props: Record<string, unknown>;
  /** Who can read the widget's chat now, read when the event arrives. */
  chatAudience(): Promise<"private" | "shared">;
  /** Starts a connection's setup, as the Connections page's Connect does. */
  startSetup(request: SetupStartRequest): Promise<SetupStartOutcome>;
  /** Whether the event came from this instance's own pages, which the setup
   *  route asks of a request too. */
  sameOrigin: boolean;
}

/** What a setup start names: as `POST /api/connections/:idOrKind/grants/:grant/setup` takes it. */
export interface SetupStartRequest {
  idOrKind: string;
  grant: string;
  force?: boolean;
}

type CoreHandler = (context: Record<string, unknown>, io: CoreIo) => Promise<CoreReply>;

/** A connection as `GET /api/connections` lists it, in the fields the connect
 *  card reads. */
interface ConnectionStatus {
  /** Null for a kind the guardian never connected. */
  id: string | null;
  connectionKind: string;
  grants: Record<string, unknown>;
  kindLabel?: string;
  state: "working" | "broken" | null;
  connect: { url: string | null; available: boolean; unavailableReason: string | null } | null;
}

/**
 * Whether a device connection of `kind` works, and its title, by the live
 * route's own choice (connections/device/live-route.ts) over the connections
 * `GET /api/device-connections` lists to the caller: a card raised for the
 * device the guardian asked from (`props.deviceId`) reads that device alone,
 * and one raised for no device skips devices silent for 7 days. So the card
 * and the read after it agree.
 */
async function deviceKindState(kind: string, io: CoreIo) {
  const deviceId = typeof io.props.deviceId === "string" ? io.props.deviceId : undefined;
  const rows = await io.deviceConnections();
  const pointer = createLiveRoutes({ list: () => rows }).forKind(kind, {
    askingDeviceId: deviceId,
  });
  return {
    working: pointer.state === "working",
    label:
      (pointer.state !== "not_connected" ? pointer.title : undefined) ??
      rows.find((c) => c.capability === kind)?.title ??
      kind,
  };
}

/**
 * The setup the Connections page's button starts for a kind that does not
 * work: Reconnect on a broken connection, which starts afresh, else Connect on
 * the kind, or on the one connection it lists. Null when no listing names a grant.
 */
function setupTarget(ofKind: readonly ConnectionStatus[]): SetupStartRequest | null {
  const chosen =
    ofKind.find((c) => c.state === "broken") ?? ofKind.find((c) => c.id === null) ?? ofKind[0];
  const grant = chosen ? Object.keys(chosen.grants ?? {})[0] : undefined;
  if (!chosen || !grant) return null;
  return {
    idOrKind: chosen.id ?? chosen.connectionKind,
    grant,
    force: chosen.state === "broken",
  };
}

/**
 * The widgets core owns, by kind, and how each handles its events. The question
 * card's Send answers the agent with what was picked and typed, and its Dismiss
 * declines. The connect card's Connect starts the setup the Connections page
 * starts and opens its authorization page, or answers at once when the
 * connection is working; its
 * Check answers once the connection is working; its Dismiss declines. For a
 * device kind, Connect opens the device's page, which the device's own app
 * turns into its flow, and Check reads the device connections. Core
 * turns the answer into what the agent reads when the turn starts.
 */
const CORE_WIDGETS: Record<string, Record<string, CoreHandler>> = {
  "question-card": {
    send: async (context) => ({ answer: context }),
    dismiss: async () => ({ answer: { dismissed: true } }),
  },
  "connect-card": {
    connect: async (context, io) => {
      const kind = String(io.props.kind ?? context.kind ?? "");
      if (io.props.device === true) {
        const device = await deviceKindState(kind, io);
        if (device.working) return { answer: { kind, status: "connected" } };
        return { open: deviceConnectPath(kind) };
      }
      const ofKind = (await io.connections()).filter((c) => c.connectionKind === kind);
      if (ofKind.some((c) => c.state === "working")) {
        return { answer: { kind, status: "connected" } };
      }
      // A kind can list more than one connection; any one with a link starts it.
      const connect = ofKind.find((c) => c.connect?.available && c.connect.url)?.connect;
      if (!connect?.url) {
        const reason =
          ofKind.find((c) => c.connect?.unavailableReason)?.connect?.unavailableReason ??
          `${kind} can't be connected from the chat on this instance.`;
        return Response.json({ error: reason }, { status: 409 });
      }
      // Shopify asks which store on its own install page, which the
      // Connections page's Connect opens too.
      if (kind === "shopify") return { open: connect.url };
      if (!io.sameOrigin) {
        return Response.json({ error: "Cross-site requests are not allowed." }, { status: 403 });
      }
      const target = setupTarget(ofKind);
      if (!target) {
        return Response.json(
          { error: `Connect ${kind} in Settings › Connections.` },
          { status: 409 },
        );
      }
      const outcome = await io.startSetup(target);
      if (outcome.status === "refused") {
        return Response.json({ error: outcome.error }, { status: outcome.code });
      }
      const { state } = outcome.started;
      if (state.status === "awaiting-redirect") return { open: state.url };
      if (state.status === "done") return { answer: { kind, status: "connected" } };
      const label = ofKind[0]?.kindLabel ?? kind;
      return Response.json(
        {
          error:
            state.status === "failed"
              ? state.reason
              : `Finish connecting ${label} in Settings › Connections.`,
        },
        { status: 409 },
      );
    },
    check: async (context, io) => {
      const kind = String(io.props.kind ?? context.kind ?? "");
      if (io.props.device === true) {
        const device = await deviceKindState(kind, io);
        if (device.working) return { answer: { kind, status: "connected" } };
        return Response.json(
          {
            error: `${device.label} isn't connected yet. Connect it on your device, then try again.`,
          },
          { status: 409 },
        );
      }
      const connections = (await io.connections()).filter((c) => c.connectionKind === kind);
      if (connections.some((c) => c.state === "working")) {
        return { answer: { kind, status: "connected" } };
      }
      // Pressed before the authorization landed: say so, so the press shows.
      const label = connections[0]?.kindLabel ?? kind;
      return Response.json(
        { error: `${label} isn't connected yet. Finish authorizing, then try again.` },
        { status: 409 },
      );
    },
    dismiss: async (context) => ({ answer: { kind: context.kind, dismissed: true } }),
  },
  // Share carries the position the client read from the device; Not now declines.
  [LOCATION_CARD_ID]: {
    [SHARE_LOCATION_EVENT]: async (context, io) => {
      const shared = sharedLocationAnswer(context);
      if (!shared) return Response.json({ error: "No location was sent." }, { status: 400 });
      // The chat may have become shared since the card was shown, as when
      // visitors were let in: then the position reaches nobody, and the card
      // is answered as declined.
      if ((await io.chatAudience()) !== "private") return { answer: DECLINED_LOCATION };
      // A share the client sent by itself is marked so only on a card core
      // marked for it; a client cannot mark any other.
      const auto = context.auto === true && typeof io.props.autoShareToken === "string";
      return { answer: auto ? { ...shared, auto: true } : shared };
    },
    [DECLINE_LOCATION_EVENT]: async () => ({ answer: DECLINED_LOCATION }),
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
/**
 * Events a core card takes with no button for them: a device's connect card
 * gets `check` from the device's app once its flow ends.
 */
const CORE_UNSHOWN_EVENTS: Record<string, readonly string[]> = {
  "connect-card": ["check"],
};

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
  /** The props core stored with a widget it owns. */
  props: Record<string, unknown>;
  components: unknown[];
  waits: boolean;
}

export interface WidgetEventDeps {
  webchatRepo: Pick<WebChatRepository, "widgetMessage" | "getMessages" | "askingDeviceOf">;
  /** Hands a request to Rome's own API, as if the caller had sent it there.
   *  `env` is the incoming request's, so the caller resolves the same way. */
  forward: (request: Request, env: unknown) => Response | Promise<Response>;
  /** Who can read a dashboard chat now. Absent, every chat reads as shared,
   *  so no location is accepted. */
  chatAudience?: (chatId: string) => Promise<"private" | "shared">;
  /** Starts a connection's setup: the operation behind the Connections page's
   *  Connect. Absent, the connect card's Connect starts none and says so. */
  startSetup?: (request: SetupStartRequest) => Promise<SetupStartOutcome>;
}

/**
 * Where a client (the web dashboard or the iOS app) sends every event a widget
 * fires. A widget is a message of its own, so its id is the message's id.
 * Core finds it, checks that the widget declares the event, then hands the event to the widget's owner: an app's
 * widget calls the app at `/api/apps/<app id>/<event>`; a widget core owns,
 * such as the question card, is handled here, and its answer becomes a turn in
 * the chat. The client only sends the event; it never decides what it means.
 */
export function widgetEventRoutes(deps: WidgetEventDeps): Hono {
  const app = new Hono();
  /** The cards whose answer is on its way to their chat. */
  const answering = new Set<string>();

  app.post("/chat/widgets/:id/events", async (c) => {
    const widgetId = c.req.param("id");
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      context?: unknown;
      turn?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const context = isObject(body?.context) ? body.context : {};

    const message = await deps.webchatRepo.widgetMessage(widgetId);
    if (!message) return c.json({ error: "No widget with this id" }, 404);
    const widget = readWidget(message.chatId, message.content);
    if (!widget) return c.json({ error: "No widget with this id" }, 404);
    const unshown =
      widget.appId === "core" && CORE_UNSHOWN_EVENTS[widget.componentId ?? ""]?.includes(name);
    if (!eventNames(widget.components).has(name) && !unshown) {
      return c.json({ error: "This widget declares no such event" }, 400);
    }

    // A card the agent waits on takes events only while it waits: an answered
    // card's event would reach its owner again, and could repeat what it did.
    if (widget.waits && !(await stillWaits(message.chatId, widget.toolUseId, widgetId))) {
      return c.json({ error: "This card was already answered" }, 400);
    }

    const headers = new Headers(c.req.raw.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    // The turn an answer starts asks the device the guardian pressed it on,
    // else the device a core card was raised for, else the one the chat was
    // last handed work from, so the read after connecting goes to that device.
    if (!headers.has(ASKING_DEVICE_HEADER)) {
      const deviceId =
        (widget.appId === "core" && typeof widget.props.deviceId === "string"
          ? widget.props.deviceId
          : null) ?? (await deps.webchatRepo.askingDeviceOf(message.chatId));
      if (deviceId) headers.set(ASKING_DEVICE_HEADER, deviceId);
    }
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
      // The origin the guardian reached Rome at, which a link to a page of
      // this instance joins.
      const origin = getExternalRequestOrigin(c.req.raw).origin;
      const reply = await handle(context, {
        origin,
        props: widget.props,
        chatAudience: async () => (await deps.chatAudience?.(message.chatId)) ?? "shared",
        startSetup: async (request) =>
          deps.startSetup
            ? deps.startSetup(request)
            : { status: "refused", code: 409, error: "Connect it in Settings › Connections." },
        sameOrigin: isSameOriginMutationRequest(c.req.raw),
        connections: async () => {
          const res = await deps.forward(
            new Request(new URL("/api/connections", c.req.url), { headers }),
            c.env,
          );
          const listed = (await res.json().catch(() => null)) as {
            connections?: ConnectionStatus[];
          } | null;
          return res.ok ? (listed?.connections ?? []) : [];
        },
        deviceConnections: async () => {
          const res = await deps.forward(
            new Request(new URL("/api/device-connections", c.req.url), { headers }),
            c.env,
          );
          const listed = (await res.json().catch(() => null)) as {
            connections?: DeviceConnection[];
          } | null;
          return res.ok ? (listed?.connections ?? []) : [];
        },
      });
      if (reply instanceof Response) return reply;
      if ("answer" in reply) return answer(to, widget, widgetId, reply.answer, body?.turn);
      if ("open" in reply) {
        const open = vetLink(reply.open, origin);
        return c.json(open ? { open } : {});
      }
      return c.json({});
    }
    if (!isWidgetAppPath(name)) return c.json({ error: "The event is not a path in the app" }, 400);
    const reply = await to(`/api/apps/${encodeURIComponent(widget.appId)}/${name}`, context);
    const said = (await reply.json().catch(() => null)) as {
      answer?: unknown;
      open?: unknown;
      error?: unknown;
      message?: unknown;
    } | null;
    // A refusal tells the guardian why, in the app's words, under the field
    // every client reads.
    if (!reply.ok) {
      const why = [said?.message, said?.error].find((v) => typeof v === "string" && v !== "");
      return c.json({ error: why ?? "The app could not do that." }, reply.status as never);
    }
    // An app's widget the agent waits on answers it when the app's reply says
    // so; the answer is labelled as the app's, never as the guardian's words.
    if (widget.waits && said?.answer !== undefined) {
      // An answer that declines is a dismissal, as every dismissal is read.
      const declined = isObject(said.answer) && said.answer.dismissed === true;
      return answer(
        to,
        widget,
        widgetId,
        { ...(declined ? { dismissed: true } : {}), from: widget.appId, value: said.answer },
        body?.turn,
      );
    }
    // Core writes what the client reads: whether the agent was answered and a
    // link to open, never a field of the app's own.
    // The origin the guardian reached Rome at, which a relative link joins.
    const open = vetLink(said?.open, getExternalRequestOrigin(c.req.raw).origin);
    return c.json(open ? { open } : {});
  });

  /** Whether the card in message `widgetId` is still the open one for its
   *  tool-use id: no answer has followed it. */
  async function stillWaits(chatId: string, toolUseId: string, widgetId: string) {
    let open: string | undefined;
    for (const message of await deps.webchatRepo.getMessages(chatId)) {
      let parts: unknown;
      try {
        parts = JSON.parse(message.content);
      } catch {
        continue;
      }
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!isObject(part) || part.toolUseId !== toolUseId) continue;
        if (part.type === "pending_interaction" && message.role === "assistant") open = message.id;
        if (part.type === "interaction_result" && message.role === "user") {
          if (part.messageId === undefined || part.messageId === open) open = undefined;
        }
      }
    }
    return open === widgetId;
  }

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
    // Two clients can press the same card at once: the first answer wins,
    // and the other is refused until the chat has stored the first.
    if (answering.has(widgetId)) {
      return Response.json({ error: "This card was already answered" }, { status: 400 });
    }
    answering.add(widgetId);
    const turn = isObject(turnFields) ? turnFields : {};
    let res: Response;
    try {
      res = await to(`/api/chat/sessions/${encodeURIComponent(widget.chatId)}/turns`, {
        ...turn,
        // The message names the card pressed: a later card in the chat can
        // reuse its tool-use id.
        parts: [
          { type: "interaction_result", toolUseId: widget.toolUseId, messageId: widgetId, output },
        ],
      });
    } finally {
      answering.delete(widgetId);
    }
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
    props: isObject(part.render) && isObject(part.render.props) ? part.render.props : {},
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
