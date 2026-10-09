import { useEffect, useState } from "react";
import { startRun, useLive, useTrace } from "./api.js";
import { StatusDot, TestList } from "./TestList.js";
import { TraceView } from "./TraceView.js";

/** The selected test, kept in the URL hash so a reload keeps it. */
function useSelection(): [string | undefined, (id: string) => void] {
  const read = () => new URLSearchParams(location.hash.slice(1)).get("test") ?? undefined;
  const [selected, setSelected] = useState(read);
  useEffect(() => {
    const onHash = () => setSelected(read());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  return [selected, (id) => (location.hash = `test=${encodeURIComponent(id)}`)];
}

export function App() {
  const { index, run, revision } = useLive();
  const [selected, select] = useSelection();
  const tests = index?.tests ?? [];
  // With nothing chosen, open the first failure, else the first scenario.
  const test =
    tests.find((item) => item.id === selected) ??
    tests.find((item) => item.status === "fail") ??
    tests.find((item) => item.trace);
  const trace = useTrace(test?.trace, revision);
  const failed = tests.filter((item) => item.status === "fail").length;

  return (
    <div className="app">
      <header className="bar">
        <h1>Channel scenarios</h1>
        <p className="bar-summary" aria-live="polite">
          {run.running
            ? "Running…"
            : index
              ? `${tests.length} tests · ${failed} failed · finished ${new Date(index.finishedAt).toLocaleTimeString()}`
              : "No run yet"}
        </p>
        <button
          type="button"
          className="primary"
          disabled={run.running}
          onClick={() => void startRun()}
        >
          Run all
        </button>
      </header>
      <div className="body">
        <aside className="side">
          <TestList
            tests={tests}
            selected={test?.id}
            running={run.running}
            onSelect={select}
            onRun={(item) => void startRun([item.name])}
          />
          {!run.running &&
            run.exitCode !== undefined &&
            run.exitCode !== 0 &&
            run.log.length > 0 && (
              <details className="run-log">
                <summary>Last run exited with {run.exitCode}</summary>
                <pre>{run.log.join("\n")}</pre>
              </details>
            )}
        </aside>
        <main className="main">
          {!test ? (
            <p className="muted empty">
              {index ? "Select a test." : "Run the scenarios to see their traces here."}
            </p>
          ) : (
            <>
              <div className="test-head">
                <h2>
                  <StatusDot status={test.status} /> {test.name}
                </h2>
                <p className="muted">
                  {test.file.split("/").slice(-3).join("/")}
                  {test.durationMs !== undefined && ` · ${test.durationMs.toFixed(0)} ms`}
                </p>
              </div>
              {test.errors.map((error) => (
                <pre key={error} className="error" role="alert">
                  {error}
                </pre>
              ))}
              {!test.trace ? (
                <p className="muted">This test recorded no trace.</p>
              ) : trace ? (
                <TraceView trace={trace} />
              ) : (
                <p className="muted">Loading trace…</p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
