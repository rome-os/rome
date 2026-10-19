import { useEffect, useState, type ComponentProps, type MouseEvent } from "react";
import { cn } from "@rome-os/ui/cn";
import { Spinner } from "@rome-os/ui/spinner";
import { Laptop, Monitor, Server, Smartphone } from "lucide-react";
import { platformOf, resultOf } from "./format.js";
import { format, type NodeUiMessages } from "./messages.js";
import type { NodeActionResult, NodeActionRow } from "./protocol.js";
import type { NodeDeviceStatus, NodeNavigation } from "./types.js";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** A link the host routes. A plain left click navigates in place. */
export function NavLink({
  to,
  navigation,
  onClick,
  ...props
}: Omit<ComponentProps<"a">, "href"> & { to: string; navigation: NodeNavigation }) {
  return (
    <a
      href={to}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        navigation.navigate(to);
      }}
      {...props}
    />
  );
}

const statusDot: Record<NodeDeviceStatus, string> = {
  connected: "bg-success",
  not_connected: "bg-muted-foreground/50",
  unknown: "bg-warning",
  revoked: "border border-muted-foreground/50 bg-surface",
};

/** The device's kind as an icon in a tile, with its status as a dot on the corner. */
export function DeviceIcon({
  platform,
  status = "unknown",
  className,
}: {
  platform?: string | null;
  status?: NodeDeviceStatus;
  className?: string;
}) {
  const { kind } = platformOf(platform);
  const Icon =
    kind === "laptop"
      ? Laptop
      : kind === "desktop"
        ? Monitor
        : kind === "phone"
          ? Smartphone
          : Server;
  return (
    <span
      className={cn(
        "relative inline-flex size-9 shrink-0 items-center justify-center rounded-8 border border-border bg-surface-muted text-muted-foreground",
        className,
      )}
      aria-hidden
    >
      <Icon className="size-4" />
      <span
        className={cn(
          "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface",
          statusDot[status],
        )}
      />
    </span>
  );
}

/** The paint of each result, shared by the chart, the dots, and the filter. */
export const resultPaint: Record<NodeActionResult, string> = {
  running: "bg-info",
  succeeded: "bg-success",
  failed: "bg-destructive",
  no_result: "bg-warning",
};

/** A result as a dot and a short mono label: `exit 0`, `exit 2`, `running`, `no result`. */
export function ResultMark({
  row,
  m,
  label = true,
}: {
  row: NodeActionRow;
  m: NodeUiMessages;
  label?: boolean;
}) {
  const result = resultOf(row);
  const text =
    result === "running"
      ? m.result.running
      : row.exitCode !== null
        ? format(m.exitCode, { code: row.exitCode })
        : row.signal
          ? row.signal
          : result === "failed"
            ? (row.errorCode ?? m.result.failed)
            : result === "succeeded"
              ? m.result.succeeded
              : m.result.no_result;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-2 font-mono text-aux",
        result === "failed" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {result === "running" ? (
        <Spinner size="xs" className="text-info" />
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", resultPaint[result])} aria-hidden />
      )}
      {label ? (
        <span className="truncate" title={text}>
          {text}
        </span>
      ) : (
        <span className="sr-only">{text}</span>
      )}
    </span>
  );
}
