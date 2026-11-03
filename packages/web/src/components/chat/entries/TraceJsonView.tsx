import { useTranslation } from "react-i18next";
import { normalizeTracePayload } from "@/lib/trace-format";
import { toTraceImage, TraceImageView } from "./TracePayload";

// Strings longer than this break to their own line in entries.
const INLINE_STRING_MAX = 80;
// Primitive arrays with <= this many short entries render as inline chip rows.
const PRIMITIVE_ARRAY_CHIP_LIMIT = 8;
const PRIMITIVE_CHIP_LENGTH = 32;

type Primitive = string | number | boolean | bigint | null | undefined;

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

function isPrimitiveChippable(value: unknown): value is Primitive {
  if (!isPrimitive(value)) return false;
  if (typeof value === "string") return value.length <= PRIMITIVE_CHIP_LENGTH;
  return true;
}

export function TraceJsonView({ value }: { value: unknown }) {
  return <JsonNode value={normalizeTracePayload(value)} depth={0} isRoot />;
}

function JsonNode({ value, depth, isRoot }: { value: unknown; depth: number; isRoot?: boolean }) {
  const normalized = normalizeTracePayload(value);

  const image = toTraceImage(normalized);
  if (image) {
    const hasRest = Object.keys(image.rest).length > 0;
    if (!hasRest) return <TraceImageView src={image.src} />;
    // Preserve sibling metadata (e.g. tool screenshot annotations) so we
    // don't silently drop fields the server attached next to the image.
    return (
      <div className="flex flex-col gap-2">
        <TraceImageView src={image.src} />
        <JsonNode value={image.rest} depth={depth} isRoot={isRoot} />
      </div>
    );
  }

  if (Array.isArray(normalized)) {
    return <JsonArray value={normalized} depth={depth} isRoot={isRoot} />;
  }
  if (normalized !== null && typeof normalized === "object") {
    return (
      <JsonObject value={normalized as Record<string, unknown>} depth={depth} isRoot={isRoot} />
    );
  }
  return <JsonPrim value={normalized as Primitive} />;
}

function JsonObject({
  value,
  depth,
  isRoot,
}: {
  value: Record<string, unknown>;
  depth: number;
  isRoot?: boolean;
}) {
  const { t } = useTranslation("chat");
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return (
      <span className="font-mono text-aux italic text-subtle-foreground">
        {t("blocks.emptyObject")}
      </span>
    );
  }
  return (
    <div
      className={
        isRoot
          ? "flex flex-col gap-1"
          : "relative flex flex-col gap-1 pl-3 before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-border"
      }
    >
      {entries.map(([k, v]) => (
        <JsonEntry key={k} k={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

function JsonArray({
  value,
  depth,
  isRoot,
}: {
  value: unknown[];
  depth: number;
  isRoot?: boolean;
}) {
  const { t } = useTranslation("chat");
  if (value.length === 0) {
    return (
      <span className="font-mono text-aux italic text-subtle-foreground">
        {t("blocks.emptyList")}
      </span>
    );
  }
  if (value.length <= PRIMITIVE_ARRAY_CHIP_LIMIT && value.every(isPrimitiveChippable)) {
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((v, i) => (
          <span
            key={i}
            className="inline-flex h-[var(--badge-h)] items-center rounded-4 border border-border bg-surface px-2 font-mono text-aux text-foreground"
          >
            <JsonPrim value={v as Primitive} inline />
          </span>
        ))}
      </div>
    );
  }
  return (
    <div
      className={
        isRoot
          ? "flex flex-col gap-1"
          : "relative flex flex-col gap-1 pl-3 before:absolute before:inset-y-1 before:left-0 before:w-px before:bg-border"
      }
    >
      {value.map((v, i) => (
        <JsonEntry key={i} k={`[${i}]`} value={v} depth={depth + 1} isIndex />
      ))}
    </div>
  );
}

function JsonEntry({
  k,
  value,
  depth,
  isIndex,
}: {
  k: string;
  value: unknown;
  depth: number;
  isIndex?: boolean;
}) {
  const normalized = normalizeTracePayload(value);
  const isStructured =
    Array.isArray(normalized) || (!!normalized && typeof normalized === "object");
  const isLongString = typeof normalized === "string" && normalized.length > INLINE_STRING_MAX;
  const stacked = isStructured || isLongString;

  return (
    <div
      className={
        stacked
          ? "flex min-w-0 flex-col gap-1 font-mono text-aux"
          : "flex min-w-0 items-baseline gap-2 font-mono text-aux"
      }
    >
      <span
        className={`flex-none whitespace-nowrap text-subtle-foreground${
          isIndex ? " tabular-nums" : ""
        }`}
      >
        {k}
        <span className="inline-block translate-x-px text-subtle-foreground/60">:</span>
      </span>
      {stacked ? (
        <div className="min-w-0 translate-y-px">
          {isLongString ? (
            <LongString value={normalized as string} />
          ) : (
            <JsonNode value={normalized} depth={depth} />
          )}
        </div>
      ) : (
        <span className="min-w-0 flex-1 break-words text-foreground">
          <JsonPrim value={normalized as Primitive} inline />
        </span>
      )}
    </div>
  );
}

function JsonPrim({ value, inline }: { value: Primitive; inline?: boolean }) {
  if (value === null) {
    return <span className="italic text-subtle-foreground">null</span>;
  }
  if (value === undefined) {
    return <span className="italic text-subtle-foreground">undefined</span>;
  }
  if (typeof value === "boolean") {
    return <span className="italic text-foreground">{String(value)}</span>;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return <span className="tabular-nums text-foreground">{String(value)}</span>;
  }
  // string
  if (!inline && value.length > INLINE_STRING_MAX) {
    return <LongString value={value} />;
  }
  return <span className="text-foreground">{value}</span>;
}

function LongString({ value }: { value: string }) {
  return (
    <span className="block whitespace-pre-wrap rounded-4 border border-border bg-surface px-2 py-1 font-mono text-aux text-foreground break-words">
      {value}
    </span>
  );
}
