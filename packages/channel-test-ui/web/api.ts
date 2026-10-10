import { useEffect, useState } from "react";
import { type Trace, type TraceIndex, traceIndexSchema, traceSchema } from "../src/trace.js";

export interface RunState {
  running: boolean;
  log: string[];
  exitCode?: number | null;
}

/**
 * The run index and the latest run's state, kept current through the
 * server's events. `revision` grows on every index change, so a view holding
 * a trace knows to read it again.
 */
export function useLive(): { index: TraceIndex | null; run: RunState; revision: number } {
  const [index, setIndex] = useState<TraceIndex | null>(null);
  const [run, setRun] = useState<RunState>({ running: false, log: [] });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const raw: unknown = await (await fetch("/api/index")).json();
      if (cancelled) return;
      // An index from another trace version is the same as no run: running the
      // tests again writes a current one.
      const parsed = raw === null ? undefined : traceIndexSchema.safeParse(raw);
      setIndex(parsed?.success ? parsed.data : null);
      setRevision((value) => value + 1);
    };
    void load();
    const events = new EventSource("/api/events");
    events.addEventListener("index", () => void load());
    events.addEventListener("run", (event) => setRun(JSON.parse((event as MessageEvent).data)));
    return () => {
      cancelled = true;
      events.close();
    };
  }, []);

  return { index, run, revision };
}

/**
 * The trace at `path` under the traces directory, read again on `revision`.
 * It is `null` until the trace for this path and revision has arrived, so a
 * view never shows the trace of the test selected before.
 */
export function useTrace(path: string | undefined, revision: number): Trace | null {
  const [loaded, setLoaded] = useState<{ path: string; revision: number; trace: Trace } | null>(
    null,
  );
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void fetch(`/api/trace?path=${encodeURIComponent(path)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((raw: unknown) => {
        if (!cancelled && raw !== null)
          setLoaded({ path, revision, trace: traceSchema.parse(raw) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, revision]);
  return loaded && loaded.path === path && loaded.revision === revision ? loaded.trace : null;
}

/** Asks the server to run every scenario, or only the tests named. */
export async function startRun(names?: string[]): Promise<void> {
  await fetch("/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(names ? { names } : {}),
  });
}
