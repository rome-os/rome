/** @deprecated Informational legacy export. The CLI does not enforce a message-size limit. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const CLOSE = {
  revoked: 4001,
  superseded: 4002,
  outputLimit: 4003,
  expired: 4004,
  invalid: 1008,
  tooLarge: 1009,
} as const;

export interface OutboundEnvelope {
  id: string;
  to: string;
  payload: unknown;
}
export interface InboundEnvelope {
  id: string;
  from: string;
  payload: unknown;
}
interface RouteError {
  id: string;
  type: "error";
  code: "target_unavailable" | "invalid_message" | "message_too_large";
}
export type GatewayMessage = InboundEnvelope | RouteError;

export function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u0020\u007f]/.test(value)
  );
}

export function outboundEnvelope(value: unknown): OutboundEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!validId(item.id) || !validId(item.to) || !Object.hasOwn(item, "payload")) return null;
  return { id: item.id, to: item.to, payload: item.payload };
}

export function gatewayMessage(value: unknown): GatewayMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!validId(item.id)) return null;
  if (
    item.type === "error" &&
    ["target_unavailable", "invalid_message", "message_too_large"].includes(String(item.code))
  ) {
    return item as unknown as RouteError;
  }
  if (validId(item.from) && Object.hasOwn(item, "payload"))
    return { id: item.id, from: item.from, payload: item.payload };
  return null;
}

/**
 * A notification Rome Cloud asks this device to show. The Gateway sends it as one text frame,
 * `{"type":"notification", title, body, instanceId, level?, chatId?}`, server to client only.
 */
export interface GatewayNotification {
  title: string;
  body: string;
  /** The Rome instance the notification is about. */
  instanceId: string;
  /** `active` rings. Without a level the notification is silent. */
  level?: "active" | "passive";
  chatId?: string;
}

export const NOTIFICATION_LIMITS = { title: 200, body: 2000, id: 128 } as const;

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/**
 * Parses a notification frame, or returns null for anything else. A relayed peer message always
 * carries `id` and `from`, so a frame with either is never a notification: only the Gateway
 * itself can send one.
 */
export function gatewayNotification(value: unknown): GatewayNotification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.type !== "notification" || Object.hasOwn(item, "id") || Object.hasOwn(item, "from"))
    return null;
  if (
    !text(item.title, NOTIFICATION_LIMITS.title) ||
    !text(item.body, NOTIFICATION_LIMITS.body) ||
    !text(item.instanceId, NOTIFICATION_LIMITS.id)
  )
    return null;
  const notification: GatewayNotification = {
    title: item.title,
    body: item.body,
    instanceId: item.instanceId,
  };
  if (item.level !== undefined) {
    if (item.level !== "active" && item.level !== "passive") return null;
    notification.level = item.level;
  }
  if (item.chatId !== undefined) {
    if (!text(item.chatId, NOTIFICATION_LIMITS.id)) return null;
    notification.chatId = item.chatId;
  }
  return notification;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
