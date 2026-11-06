import { createElement as h, type ReactElement } from "react";
import { Box, Text, render } from "ink";
import type { AuditItem, AuditResult, AuditStatus, AuditStore } from "@rome-os/node-core/host";
import { auditResult, describe } from "./audit.js";

export interface ConnectViewProps {
  name: string;
  deviceId: string;
  cloud: string;
  status: string;
  /** When the status last changed, and the time now, in epoch milliseconds. */
  since: number;
  now: number;
  auditPath: string;
  auditState: AuditStatus;
  /** Requests per result. Missing when the log cannot be read. */
  counts?: Record<AuditResult | "all", number>;
  /** The newest requests first. */
  recent: AuditItem[];
}

const age = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8);

export function ConnectView(p: ConnectViewProps): ReactElement {
  const color =
    p.status === "online"
      ? "green"
      : p.status === "connecting" || p.status === "retrying"
        ? "yellow"
        : "red";
  const { counts } = p;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { bold: true }, "Connection"),
    h(Text, null, "  Status  ", h(Text, { color }, p.status), ` for ${age(p.now - p.since)}`),
    h(Text, null, `  Device  ${p.name} (${p.deviceId})`),
    h(Text, null, `  Cloud   ${p.cloud}`),
    p.auditState.state === "ok"
      ? h(Text, null, `  Audit   ${p.auditPath}`)
      : h(
          Text,
          { color: "red" },
          `  Audit   unavailable, remote requests are refused. Run rome-node audit status.\n  ${p.auditState.message}`,
        ),
    ...(counts
      ? [
          h(Text, { bold: true }, "\nSummary"),
          h(
            Text,
            null,
            `  Requests ${counts.all}, succeeded ${counts.succeeded}, failed ${counts.failed}, no result ${counts.no_result}`,
          ),
          h(Text, { bold: true }, "\nRecent"),
          ...(p.recent.length === 0 ? [h(Text, { dimColor: true }, "  No requests yet.")] : []),
          ...p.recent.map((item) =>
            h(
              Text,
              { key: item.seq, wrap: "truncate-end" },
              `  ${clock(item.at)}  ${auditResult(item).padEnd(28)}  ${describe(item)}`,
            ),
          ),
        ]
      : []),
    h(Text, { dimColor: true }, "\nCtrl+C disconnects and keeps authorization."),
  );
}

export type ConnectUi = ReturnType<typeof startConnectUi>;

/** Draws the view below the earlier output and redraws it every second and on a status change. */
export function startConnectUi(
  audit: AuditStore,
  device: { name: string; deviceId: string; cloud: string },
) {
  let status = "connecting";
  let since = Date.now();
  const view = () => {
    let data: Pick<ConnectViewProps, "counts" | "recent"> = { recent: [] };
    try {
      if (audit.state.state === "ok")
        data = {
          counts: audit.resultCounts(),
          recent: audit.list({ requestsOnly: true, limit: 5 }),
        };
    } catch {
      // The log is only displayed here. Reading it must never stop the host.
    }
    return h(ConnectView, {
      ...device,
      ...data,
      status,
      since,
      now: Date.now(),
      auditPath: audit.path,
      auditState: audit.state,
    });
  };
  // Without input handling Ctrl+C stays a SIGINT, which the caller's shutdown handles.
  const ui = render(view(), { interactive: true, exitOnCtrlC: false, patchConsole: false });
  const timer = setInterval(() => ui.rerender(view()), 1000);
  timer.unref();
  // Ink ends the process on a signal as soon as nothing else listens, before the host has stopped.
  // These come after Ink's own, so the first signal still shuts down in order and a second ends it.
  const wait = () => {};
  const signals = ["SIGINT", "SIGTERM"] as const;
  for (const signal of signals) process.once(signal, wait);
  return {
    setStatus(next: string) {
      status = next;
      since = Date.now();
      ui.rerender(view());
    },
    stop() {
      clearInterval(timer);
      for (const signal of signals) process.off(signal, wait);
      ui.unmount();
    },
  };
}
