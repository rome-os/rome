// Vendored from packages/web/src/components/chat/entries/TracePayload.tsx —
// only the image helpers `TraceJsonView` depends on. Import seams: none needed
// here (self-contained). Deviation from upstream: `TraceImageView` drops the
// `react-medium-image-zoom` wrapper (not an app dependency) and renders a plain
// inline preview with the same frame — a static replay doesn't need click-to-zoom.

// Allow only image/* MIME strings on the `data:` URL branch. A malicious server
// could otherwise hand us e.g. `text/html;...` and convince the browser to
// interpret the base64 payload as something other than an image.
function safeImageMime(raw: string | undefined, fallback = "image/png"): string {
  if (typeof raw !== "string") return fallback;
  return /^image\/[a-z0-9.+-]+$/i.test(raw) ? raw : fallback;
}

// Tool results can declare `source: { type: "url", url: ... }`. Require https +
// a non-private host before letting any tool URL reach `<img src>` (SSRF guard).
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

// Detect MCP / Anthropic-style image content blocks so we render an inline
// preview instead of dumping the base64 payload as text. Returns the resolved
// src plus the unconsumed sibling fields so unknown metadata isn't dropped.
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
    <img
      src={src}
      alt="trace image"
      className="max-h-64 max-w-full rounded-4 border border-border object-contain"
    />
  );
}
