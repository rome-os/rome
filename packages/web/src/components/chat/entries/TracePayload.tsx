import { useTranslation } from "react-i18next";
import Zoom from "react-medium-image-zoom";
import { formatTracePrimitive, normalizeTracePayload } from "@/lib/trace-format";

export function isStructuredTraceValue(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (!!value && typeof value === "object");
}

// Allow only image/* MIME strings on the `data:` URL branch. A malicious
// server could otherwise hand us e.g. `text/html;...` and convince the
// browser to interpret the base64 payload as something other than an image.
function safeImageMime(raw: string | undefined, fallback = "image/png"): string {
  if (typeof raw !== "string") return fallback;
  return /^image\/[a-z0-9.+-]+$/i.test(raw) ? raw : fallback;
}

// Tool results can declare `source: { type: "url", url: ... }`. Without
// validation the browser will fire a credentialed GET to whatever the server
// names — including private/loopback addresses, enabling SSRF-style probing
// of the user's internal network. We require https + a non-private host
// before letting any tool URL reach `<img src>`.
function safeImageUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // URL.hostname keeps the brackets on an IPv6 literal ([::1]); strip them so
  // the denylist matches the bare address — otherwise IPv6 loopback, ULA, and
  // link-local hosts all slip past (e.g. `https://[::1]/`).
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::" || // IPv6 unspecified
    host === "::1" || // IPv6 loopback
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) ||
    /^f[cd][0-9a-f]{0,2}:/.test(host) || // IPv6 ULA (fc00::/7)
    /^fe[89ab][0-9a-f]{0,2}:/.test(host) || // IPv6 link-local (fe80::/10)
    host.startsWith("::ffff:") // IPv4-mapped IPv6 (may embed a private v4)
  ) {
    return null;
  }
  return parsed.toString();
}

// Detect MCP image content blocks (e.g. chrome-devtools-mcp `take_screenshot`) and
// Anthropic-style image blocks, so we can render an inline preview instead of
// dumping the base64 payload as text. Returns the resolved src plus the
// unconsumed sibling fields so unknown metadata isn't silently dropped.
export function toTraceImage(
  value: unknown,
): { src: string; rest: Record<string, unknown> } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.type !== "image") return null;

  if (typeof v.data === "string" && v.data.length > 0) {
    const mime = safeImageMime(typeof v.mimeType === "string" ? v.mimeType : undefined);
    const { type: _type, data: _data, mimeType: _mimeType, ...rest } = v;
    return { src: `data:${mime};base64,${v.data}`, rest };
  }

  const source = v.source;
  if (source && typeof source === "object") {
    const s = source as Record<string, unknown>;
    if (s.type === "base64" && typeof s.data === "string") {
      const mime = safeImageMime(typeof s.media_type === "string" ? s.media_type : undefined);
      const { type: _type, source: _source, ...rest } = v;
      return { src: `data:${mime};base64,${s.data}`, rest };
    }
    if (s.type === "url") {
      const safe = safeImageUrl(s.url);
      if (!safe) return null;
      const { type: _type, source: _source, ...rest } = v;
      return { src: safe, rest };
    }
  }

  return null;
}

export function TraceImageView({ src }: { src: string }) {
  return (
    <Zoom>
      <img
        src={src}
        alt="trace image"
        className="max-h-64 max-w-full rounded-4 border border-border object-contain"
      />
    </Zoom>
  );
}

export function TracePayloadView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const { t } = useTranslation("chat");
  const normalized = normalizeTracePayload(value);

  const image = toTraceImage(normalized);
  if (image) {
    const hasRest = Object.keys(image.rest).length > 0;
    return (
      <div className="space-y-1 relative">
        <TraceImageView src={image.src} />
        {hasRest && <TracePayloadView value={image.rest} depth={depth} />}
      </div>
    );
  }

  if (Array.isArray(normalized)) {
    if (normalized.length === 0) {
      return <span className="italic opacity-70">{t("blocks.emptyList")}</span>;
    }

    return (
      <div className={`space-y-1 font-mono ${depth > 0 ? "pl-3" : ""}`}>
        {normalized.map((item, index) => {
          const normalizedItem = normalizeTracePayload(item);
          const structured = isStructuredTraceValue(normalizedItem);

          return (
            <div key={index} className="rounded-4 border border-black/10 bg-surface/60 px-2 py-1">
              {structured ? (
                <>
                  <div className="opacity-70">[{index}]</div>
                  <div className="mt-1">
                    <TracePayloadView value={normalizedItem} depth={depth + 1} />
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-x-2 gap-y-1">
                  <span className="opacity-70">[{index}]:</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {formatTracePrimitive(normalizedItem)}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  if (normalized && typeof normalized === "object") {
    const entries = Object.entries(normalized as Record<string, unknown>);
    if (entries.length === 0) {
      return <span className="italic opacity-70">{t("blocks.emptyObject")}</span>;
    }

    return (
      <div className={`space-y-1 font-mono ${depth > 0 ? "pl-3" : ""}`}>
        {entries.map(([key, entryValue]) => {
          const normalizedEntryValue = normalizeTracePayload(entryValue);
          const structured = isStructuredTraceValue(normalizedEntryValue);

          return (
            <div key={key} className="rounded-4 border border-black/10 bg-surface/60 px-2 py-1">
              {structured ? (
                <>
                  <div className="break-all">{key}:</div>
                  <div className="mt-1">
                    <TracePayloadView value={normalizedEntryValue} depth={depth + 1} />
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-x-2 gap-y-1">
                  <span className="break-all">{key}:</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                    {formatTracePrimitive(normalizedEntryValue)}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="font-mono whitespace-pre-wrap break-words">
      {formatTracePrimitive(normalized)}
    </div>
  );
}

export function formatTraceNumber(value: number | undefined): string {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export function formatUsd(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value === 0) {
    return "$0.00";
  }
  if (Math.abs(value) >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (Math.abs(value) >= 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(6)}`;
}
