import { describe, expect, it } from "@rstest/core";
import { createElement } from "react";
import { render } from "ink-testing-library";
import type { AuditItem } from "@rome-os/node-core/host";
import { ConnectView, type ConnectViewProps } from "./connect-ui.js";

const at = Date.parse("2026-11-03T09:12:41");
const item = (seq: number, action: string, args: object, end: AuditItem["end"]): AuditItem => ({
  seq,
  at: at + seq * 1000,
  kind: "start",
  action,
  startSeq: null,
  outcome: null,
  record: { args },
  end,
});
const end = (outcome: string, record: object) =>
  ({ seq: 99, at, kind: "end", action: "exec", startSeq: 1, outcome, record }) as AuditItem["end"];

const props: ConnectViewProps = {
  name: "Build server",
  deviceId: "3f2a9c1e-1111-4222-8333-444455556666",
  cloud: "https://romeos.cc",
  status: "online",
  since: at,
  now: at + 125_000,
  auditPath: "/home/me/.rome-node/audit/audit.db",
  auditState: { state: "ok" },
  counts: { all: 4, succeeded: 2, failed: 1, no_result: 1 },
  recent: [
    item(4, "exec", { command: "sleep", args: ["60"] }, null),
    item(3, "fs.list", { path: "/work" }, end("ok", { durationMs: 3 })),
    item(2, "exec", { command: "false" }, end("exit_nonzero", { exitCode: 1, durationMs: 12 })),
    item(
      1,
      "exec",
      { command: "git", args: ["status"] },
      end("ok", { exitCode: 0, durationMs: 40 }),
    ),
  ],
};
const frame = (over: Partial<ConnectViewProps> = {}) => {
  const ui = render(createElement(ConnectView, { ...props, ...over }));
  const text = ui.lastFrame() ?? "";
  ui.unmount();
  return text;
};

describe("rome-node connect screen", () => {
  it("shows the connection, the request counts, and the latest requests the way audit tail words them", () => {
    const text = frame();
    expect(text).toContain("online for 2m 5s");
    expect(text).toContain("Build server (3f2a9c1e-1111-4222-8333-444455556666)");
    expect(text).toContain("/home/me/.rome-node/audit/audit.db");
    expect(text).toContain("Requests 4, succeeded 2, failed 1, no result 1");
    expect(text).toMatch(/\d\d:\d\d:\d\d {2}no end record\s+sleep 60/);
    expect(text).toMatch(/exit_nonzero exit=1 12ms\s+false/);
    expect(text).toMatch(/ok exit=0 40ms\s+git status/);
    expect(text.indexOf("sleep 60")).toBeLessThan(text.indexOf("git status"));
  });

  it("tells a missing log apart and says requests are refused", () => {
    const text = frame({
      counts: undefined,
      recent: [],
      auditState: { state: "unavailable", code: "io", message: "disk full (/x/audit.db)" },
    });
    expect(text).toContain("remote requests are refused. Run rome-node audit status.");
    expect(text).toContain("disk full (/x/audit.db)");
    expect(text).not.toContain("Summary");
  });

  it("says so when nothing has run yet", () => {
    expect(
      frame({ counts: { all: 0, succeeded: 0, failed: 0, no_result: 0 }, recent: [] }),
    ).toContain("No requests yet.");
  });
});
