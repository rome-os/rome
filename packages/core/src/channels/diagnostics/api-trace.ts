import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger } from "../../logger.js";

export const imApiTraceSchema = z
  .string()
  .default("off")
  .transform((value) =>
    (value.trim() === "true" ? "all" : value).split(",").map((part) => part.trim()),
  )
  .pipe(z.array(z.enum(["off", "all", "discord", "lark", "feishu", "telegram", "wechat"])));
export type ImPlatform = "discord" | "lark" | "feishu" | "telegram" | "wechat";
export interface ImApiTraceEvent {
  schemaVersion: 1;
  exchangeId: string;
  platform: ImPlatform;
  boundary: "http" | "sdk";
  phase: "request" | "response" | "response-body" | "error";
  timestamp: string;
  durationMs?: number;
  detail: unknown;
}
const log = createLogger("im-api-trace");
let platforms: readonly string[] = [];
let sink = (event: ImApiTraceEvent) => log.info("IM API trace", { event });
const LIMIT = 32_768;
const secret =
  /authorization|^auth$|cookie|token|secret|password|credential|signature|^sig$|^hm$|appsecret|context_token|encrypt|aes[_-]?key|upload_param|api[_-]?key|ticket/i;

export function configureImApiTrace(
  selected: readonly string[],
  emit?: (event: ImApiTraceEvent) => void,
) {
  platforms = selected;
  sink = emit ?? ((event) => log.info("IM API trace", { event }));
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.pathname = url.pathname
      .replace(/\/bot[^/]+\//g, "/bot[redacted]/")
      .replace(/(\/webhooks\/[^/]+\/)[^/]+/g, "$1[redacted]");
    for (const key of url.searchParams.keys()) {
      if (secret.test(key) || key === "key" || key === "code")
        url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth limit]";
  if (typeof value === "string") {
    if (/^(https?|wss?):\/\//.test(value)) return safeUrl(value);
    if (/^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(sanitize(JSON.parse(value), depth + 1));
      } catch {
        return value.slice(0, LIMIT);
      }
    }
    return value.slice(0, LIMIT);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return null;
  if (value instanceof Headers) return sanitize(Object.fromEntries(value), depth + 1);
  if (value instanceof URLSearchParams) return sanitize(Object.fromEntries(value), depth + 1);
  if (value instanceof FormData)
    return Array.from(value, ([name, item]) => ({
      name,
      value: secret.test(name) ? "[redacted]" : sanitize(item, depth + 1),
    }));
  if (value instanceof Blob)
    return { omitted: "binary", bytes: value.size, contentType: value.type };
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return { omitted: "binary", bytes: value.byteLength };
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      return { omitted: "non-JSON object" };
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([key, item]) => [
          key,
          secret.test(key) || (key === "code" && typeof item === "string")
            ? "[redacted]"
            : sanitize(item, depth + 1),
        ]),
    );
  }
  return "[omitted]";
}

function emit(event: Omit<ImApiTraceEvent, "schemaVersion" | "timestamp">) {
  try {
    const safe = sanitize(event.detail);
    const encoded = JSON.stringify(safe);
    const detail =
      Buffer.byteLength(encoded) > LIMIT
        ? {
            ...Object.fromEntries(
              Object.entries(safe && typeof safe === "object" ? safe : {}).flatMap(
                ([key, value]) =>
                  ["method", "url", "status", "code", "name"].includes(key) &&
                  (typeof value === "string" || typeof value === "number")
                    ? [[key, typeof value === "string" ? value.slice(0, 1024) : value]]
                    : [],
              ),
            ),
            omitted: "size limit",
            bytes: Buffer.byteLength(encoded),
          }
        : safe;
    sink({
      ...event,
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      detail,
    });
  } catch {
    /* Diagnostics must not change delivery outcomes. */
  }
}

export async function traceImApi<T>(
  platform: ImPlatform,
  boundary: ImApiTraceEvent["boundary"],
  request: unknown,
  run: () => Promise<T>,
  response: (value: T, recordBody: (body: unknown) => void) => unknown | Promise<unknown> = (
    value,
  ) => value,
): Promise<T> {
  if (platforms.includes("off") || !(platforms.includes("all") || platforms.includes(platform)))
    return run();
  const exchangeId = randomUUID();
  const started = performance.now();
  const common = { platform, boundary, exchangeId };
  emit({ ...common, phase: "request", detail: request });
  let result: T;
  try {
    result = await run();
  } catch (error) {
    const failure = error as {
      response?: { status?: number; data?: unknown; headers?: unknown };
    } | null;
    emit({
      ...common,
      phase: "error",
      durationMs: performance.now() - started,
      detail: {
        name: error instanceof Error ? error.name : "Error",
        ...(failure?.response
          ? {
              status: failure.response.status,
              body: failure.response.data,
              headers: failure.response.headers,
            }
          : {}),
      },
    });
    throw error;
  }
  const durationMs = performance.now() - started;
  // Parsing the diagnostic copy must never consume or fail the caller's response.
  try {
    emit({
      ...common,
      phase: "response",
      durationMs,
      detail: await response(result, (body) =>
        emit({
          ...common,
          phase: "response-body",
          durationMs: performance.now() - started,
          detail: { body },
        }),
      ),
    });
  } catch {
    emit({ ...common, phase: "response", durationMs, detail: { omitted: "unreadable response" } });
  }
  return result;
}

export async function describeResponse(response: Response) {
  const metadata = { status: response.status, headers: Object.fromEntries(response.headers) };
  if (!response.headers.get("content-type")?.includes("json"))
    return { ...metadata, body: { omitted: "non-JSON body" } };
  const copy = response.clone();
  const reader = copy.body?.getReader();
  if (!reader) return metadata;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Trace read timeout")), 250);
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), expired]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > LIMIT) return { ...metadata, body: { omitted: "size limit" } };
      chunks.push(next.value);
    }
    return { ...metadata, body: JSON.parse(Buffer.concat(chunks).toString()) };
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

export function traceImFetch(platform: ImPlatform, request: typeof fetch): typeof fetch {
  return (input, init) =>
    traceImApi(
      platform,
      "http",
      {
        url: String(input instanceof Request ? input.url : input),
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        ),
        body:
          init?.body ??
          (input instanceof Request && input.body ? { omitted: "request stream" } : undefined),
      },
      () => request(input, init),
      describeResponse,
    );
}
