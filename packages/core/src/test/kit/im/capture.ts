import { z } from "zod";

/**
 * A reviewed, sanitized recording of real exchanges with one platform. Peers
 * build every response they can from a capture, so the shapes a test sees are
 * the platform's, not a guess. See ./README.md#captures.
 */
const captureSchema = z.object({
  platform: z.string(),
  recordedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** The SDK or adapter that made the requests, with its version. */
  client: z.string(),
  notes: z.string(),
  /** Keys whose values differ on every run (timestamps), ignored when a peer's
   *  answer is compared with the recording. */
  volatile: z.array(z.string()),
  exchanges: z
    .array(
      z.object({
        /** Names the case a peer answers with this exchange's response. */
        label: z.string().min(1),
        request: z.object({ method: z.string(), path: z.string(), body: z.unknown() }),
        /** `status` is absent where only the SDK's parsed result was recorded. */
        response: z.object({ status: z.number().int().optional(), body: z.unknown() }),
      }),
    )
    .min(1),
});

export type Capture = z.infer<typeof captureSchema>;
type CapturedExchange = Capture["exchanges"][number];

/** Validates a capture once, when the peer that answers from it loads. */
export function loadCapture(raw: unknown): Capture {
  return captureSchema.parse(raw);
}

/** A copy of the first recorded response body labelled `label`. */
export function exemplar<T = Record<string, unknown>>(capture: Capture, label: string): T {
  const exchange = capture.exchanges.find((item) => item.label === label);
  if (!exchange) throw new Error(`${capture.platform} capture has no "${label}" exchange`);
  return structuredClone(exchange.response.body) as T;
}

/**
 * What a recording pins down about an answer: its status where one was
 * recorded, and its body with every non-null `volatile` value replaced by a
 * marker. Compare a peer's answer and the recorded one through this.
 */
export function comparable(
  capture: Capture,
  answer: { status?: number; body: unknown },
  recorded: CapturedExchange["response"],
): { status?: number; body: unknown } {
  return {
    ...(recorded.status !== undefined ? { status: answer.status } : {}),
    body: stripVolatile(answer.body, capture.volatile),
  };
}

function stripVolatile(value: unknown, volatile: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, volatile));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      volatile.includes(key) && item !== null ? "<volatile>" : stripVolatile(item, volatile),
    ]),
  );
}
