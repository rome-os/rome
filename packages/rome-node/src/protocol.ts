export const MAX_MESSAGE_BYTES = 128 * 1024;
// Client adapters expose the actual pending send buffer; this is not a lifetime quota.
export const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;
export const CLOSE = {
  revoked: 4001,
  superseded: 4002,
  outputLimit: 4003,
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

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
