import { Alert, AlertDescription, AlertTitle } from "@rome-os/ui/alert";
import { Button } from "@rome-os/ui/button";
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
    <div className="flex min-h-screen flex-col sm:h-screen">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2">
        <h1 className="text-section text-foreground">Channel scenarios</h1>
        <p
          className="order-last basis-full text-ui text-muted-foreground sm:order-none sm:flex-1 sm:basis-auto"
          aria-live="polite"
        >
          {run.running
            ? "Running…"
            : index
              ? `${tests.length} tests · ${failed} failed · finished ${new Date(index.finishedAt).toLocaleTimeString()}`
              : "No run yet"}
        </p>
        <Button disabled={run.running} onClick={() => void startRun()}>
          Run all
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <aside className="max-h-[45vh] flex-none overflow-auto border-b border-border bg-surface sm:max-h-none sm:w-[340px] sm:border-r sm:border-b-0">
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
              <div className="p-3">
                <Alert variant="destructive">
                  <AlertTitle>Last run exited with {run.exitCode}</AlertTitle>
                  <AlertDescription>
                    <pre className="max-h-60 overflow-auto font-mono text-aux whitespace-pre-wrap">
                      {run.log.join("\n")}
                    </pre>
                  </AlertDescription>
                </Alert>
              </div>
            )}
        </aside>
        <main className="min-w-0 flex-1 overflow-auto p-4">
          {!test ? (
            <p className="py-8 text-center text-ui text-muted-foreground">
              {index ? "Select a test." : "Run the scenarios to see their traces here."}
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-col gap-0.5">
                <h2 className="flex items-center gap-2 text-section text-foreground">
                  <StatusDot status={test.status} /> {test.name}
                </h2>
                <p className="text-ui text-muted-foreground">
                  {test.file.split("/").slice(-3).join("/")}
                  {test.durationMs !== undefined && ` · ${test.durationMs.toFixed(0)} ms`}
                </p>
              </div>
              {test.errors.map((error) => (
                <Alert key={error} variant="destructive" className="mb-3">
                  <AlertDescription className="font-mono text-aux whitespace-pre-wrap">
                    {error}
                  </AlertDescription>
                </Alert>
              ))}
              {!test.trace ? (
                <p className="text-ui text-muted-foreground">This test recorded no trace.</p>
              ) : trace ? (
                <TraceView trace={trace} />
              ) : (
                <p className="text-ui text-muted-foreground">Loading trace…</p>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
