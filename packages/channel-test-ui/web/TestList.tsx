import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import { List, ListRow } from "@rome-os/ui/list-row";
import { SegmentedControl } from "@rome-os/ui/segmented-control";
import { RotateCw } from "lucide-react";
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
    <nav aria-label="Tests" className="flex flex-col">
      <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-border bg-surface p-3">
        <Input
          type="search"
          size="sm"
          placeholder="Filter by name"
          aria-label="Filter by name"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SegmentedControl
          size="sm"
          aria-label="Filter by status"
          value={status}
          onValueChange={setStatus}
          options={FILTERS.map(([value, label]) => ({
            value,
            label: (
              <>
                {label} <span className="text-muted-foreground">{countOf(tests, value)}</span>
              </>
            ),
          }))}
        />
      </div>
      {files.length === 0 && <p className="p-3 text-ui text-muted-foreground">No tests match.</p>}
      {files.map(([file, fileTests]) => (
        <section key={file}>
          <h2 className="truncate px-3 pt-3 pb-1 text-aux text-muted-foreground" title={file}>
            {file.split("/").at(-1)}
          </h2>
          <List asChild>
            <ul>
              {fileTests.map((test) => (
                <ListRow
                  key={test.id}
                  asChild
                  interactive
                  selected={test.id === selected}
                  className="py-1 pr-1"
                >
                  <li>
                    {/* A bare button: a test's name wraps over several lines, and `Button` is a
                        single-line control of fixed height. */}
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none outline-1 -outline-offset-4 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
                      onClick={() => onSelect(test.id)}
                    >
                      <StatusDot status={test.status} />
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{test.name}</span>
                    </button>
                    <IconButton
                      size="sm"
                      label={`Run ${test.name}`}
                      icon={<RotateCw />}
                      disabled={running}
                      onClick={() => onRun(test)}
                    />
                  </li>
                </ListRow>
              ))}
            </ul>
          </List>
        </section>
      ))}
    </nav>
  );
}

const DOT_CLASSES: Record<Test["status"], string> = {
  pass: "bg-success",
  fail: "bg-destructive",
  skip: "bg-muted-foreground/50",
  todo: "bg-muted-foreground/50",
};

export function StatusDot({ status }: { status: Test["status"] }) {
  const label = { pass: "Passed", fail: "Failed", skip: "Skipped", todo: "To do" }[status];
  return (
    <span
      className={`inline-block size-2 flex-none rounded-full ${DOT_CLASSES[status]}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

function countOf(tests: Test[], status: StatusFilter): number {
  return status === "all" ? tests.length : tests.filter((test) => test.status === status).length;
}
