// @rstest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { FakeTurnStream, stepsSummary } from "@/test/fake-turn-stream";
import { useSubagentProgress } from "./use-subagent-progress";

let stream = new FakeTurnStream();
rs.mock("@/lib/chat-api", () => ({ openTurnStream: async () => stream.response }));
rs.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: { count?: number }) => {
      if (key === "trace.summary.joiner") return " · ";
      return key.endsWith("stepsSingle") ? `${params?.count} step` : `${params?.count} steps`;
    },
  }),
}));

afterEach(cleanup);

describe("useSubagentProgress", () => {
  it("shows a late reader the same elapsed time as the reader that saw the run end", async () => {
    stream = new FakeTurnStream();
    const startedAtMs = Date.now() - 80_000;
    const props = { turnId: "progress-turn", running: true, startedAtMs };
    // A chip that keeps the finished stream until its stored summary loads.
    const chip = renderHook(() => useSubagentProgress({ ...props, retain: true }));
    await act(async () => {
      stream.send("summary_update", stepsSummary(7));
      stream.send("done", { success: true });
    });
    await waitFor(() => expect(chip.result.current.label).toBe("7 steps · 1m 20s"));

    // A row whose parent status still says running mounts after the end.
    await act(async () => new Promise((r) => setTimeout(r, 1_200)));
    const row = renderHook(() => useSubagentProgress(props));
    expect(row.result.current.label).toBe("7 steps · 1m 20s");
    expect(chip.result.current.label).toBe("7 steps · 1m 20s");
  });
});
