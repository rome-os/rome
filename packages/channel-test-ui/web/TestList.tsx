import { useMemo, useState } from "react";
import type { TraceIndex } from "../src/trace.js";

type Test = TraceIndex["tests"][number];
type StatusFilter = "all" | "fail" | "pass" | "skip";

const FILTERS: Array<[StatusFilter, string]> = [
  ["all", "All"],
  ["fail", "Failed"],
  ["pass", "Passed"],
  ["skip", "Skipped"],
];

/** Tests grouped by file, scenario files first, filtered by name and status. */
export function TestList({
  tests,
  selected,
  running,
  onSelect,
  onRun,
}: {
  tests: Test[];
  selected?: string;
  running: boolean;
  onSelect: (id: string) => void;
  onRun: (test: Test) => void;
}) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");

  const files = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, Test[]>();
    for (const test of tests) {
      if (status !== "all" && test.status !== status) continue;
      if (needle && !test.name.toLowerCase().includes(needle)) continue;
      groups.set(test.file, [...(groups.get(test.file) ?? []), test]);
    }
    // Files whose tests recorded traces, the scenarios, come first.
    const traced = (group: Test[]) => (group.some((test) => test.trace) ? 0 : 1);
    return [...groups.entries()].sort(([, a], [, b]) => traced(a) - traced(b));
  }, [tests, query, status]);

  return (
    <nav className="list" aria-label="Tests">
      <div className="list-filters">
        <input
          type="search"
          placeholder="Filter by name"
          aria-label="Filter by name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="segmented" role="radiogroup" aria-label="Filter by status">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={status === value}
              onClick={() => setStatus(value)}
            >
              {label} <span className="count">{countOf(tests, value)}</span>
            </button>
          ))}
        </div>
      </div>
      {files.length === 0 && <p className="muted list-empty">No tests match.</p>}
      {files.map(([file, fileTests]) => (
        <section key={file}>
          <h2 className="list-file" title={file}>
            {file.split("/").at(-1)}
          </h2>
          <ul>
            {fileTests.map((test) => (
              <li key={test.id} className={test.id === selected ? "selected" : undefined}>
                <button type="button" className="list-test" onClick={() => onSelect(test.id)}>
                  <StatusDot status={test.status} />
                  <span className="list-name">{test.name}</span>
                </button>
                <button
                  type="button"
                  className="icon-button"
                  disabled={running}
                  aria-label={`Run ${test.name}`}
                  title="Run this test"
                  onClick={() => onRun(test)}
                >
                  ↻
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

export function StatusDot({ status }: { status: Test["status"] }) {
  const label = { pass: "Passed", fail: "Failed", skip: "Skipped", todo: "To do" }[status];
  return <span className={`dot dot-${status}`} role="img" aria-label={label} title={label} />;
}

function countOf(tests: Test[], status: StatusFilter): number {
  return status === "all" ? tests.length : tests.filter((test) => test.status === status).length;
}
