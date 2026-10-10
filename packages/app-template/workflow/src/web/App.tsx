import "./styles.css";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchAppApi, type RomeAppBootstrap } from "@rome-os/app-web-sdk";

// Per-workflow copy. Ask for input only when the workflow consumes it.
const COPY = {
  title: "__APP_NAME__",
  whatItDoes: "Describe in one plain sentence what this automation does for you.",
  // A button verb tied to the outcome: "Update now", "Find founders now", …
  runVerb: "Run now",
  // Flip on only when the workflow genuinely reads user-typed text.
  needsInput: false,
  inputLabel: "What should I use?",
  inputPlaceholder: "",
  // Turn ON when the workflow performs real external actions (sends a message,
  // creates an issue, posts to an API). The manual button then runs a safe
  // PREVIEW by default — so pressing it never fires a real action by surprise —
  // and "Run for real" is a separate, confirmed step. Most such workflows fire
  // on their own trigger; the line below says so to the guardian.
  hasSideEffects: false,
  autoTriggerNote: "This usually runs on its own. Use the button to preview it.",
};

interface ResultEnvelope {
  message: string | null;
  ok: boolean;
  raw: unknown;
}

function readEnvelope(value: unknown): ResultEnvelope {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return {
      message: typeof o.message === "string" ? o.message : null,
      ok: o.ok !== false,
      raw: value,
    };
  }
  return { message: null, ok: true, raw: value };
}

/** Timestamps are epoch milliseconds. */
interface RunRecord {
  id: string;
  status: "running" | "success" | "error";
  dryRun: boolean;
  input: unknown;
  result: unknown;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
}

// Run status is a small fixed enum, so a per-status fill token kept in one place
// is the sanctioned exception to "paint only with chrome tokens".
const STATUS_DOT: Record<RunRecord["status"], string> = {
  success: "bg-success",
  error: "bg-destructive",
  running: "bg-primary",
};

function statusLabel(r: RunRecord): string {
  if (r.status === "running") return "Working…";
  if (r.status === "error") return "Couldn't finish";
  return readEnvelope(r.result).ok ? "Done" : "Nothing found";
}

function timeAgo(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Minimal renderer for the light markdown an LLM `message` uses: paragraphs
// (blank-line separated), single line breaks, `**bold**`, and `-`/`*`/`•`
// bullets. It emits React elements (never raw HTML / dangerouslySetInnerHTML),
// so message text can't inject markup. Anything fancier degrades to plain text.
function renderInline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        <span key={i}>{part}</span>
      ),
    );
}

function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-foreground">
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                <li key={li}>{renderInline(l.replace(/^\s*[-*•]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <span key={li}>
                {li > 0 && <br />}
                {renderInline(l)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Details({ children }: { children: ReactNode }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">Details</summary>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap rounded-md bg-surface-muted p-2 text-[11px] text-surface-muted-foreground">
        {children}
      </pre>
    </details>
  );
}

function Outcome({ result, dryRun }: { result: unknown; dryRun: boolean }) {
  const { message, ok, raw } = readEnvelope(result);
  if (!ok) {
    return (
      <div className="rounded-md border border-border bg-surface-muted px-3 py-3 text-muted-foreground">
        {message ? (
          <Markdown text={message} />
        ) : (
          <p className="text-[13px]">Nothing to show this time.</p>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-surface-muted p-3">
      {dryRun && (
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Preview — nothing was actually sent.
        </p>
      )}
      {message ? <Markdown text={message} /> : <p className="text-[13px] text-foreground">Done.</p>}
      {(message == null || (raw != null && typeof raw === "object")) && (
        <Details>{JSON.stringify(raw, null, 2)}</Details>
      )}
    </div>
  );
}

export default function App({ bootstrap }: { bootstrap: RomeAppBootstrap }) {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<unknown>(undefined);
  const [resultDryRun, setResultDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetchAppApi("runs", { method: "GET" });
      const body = (await res.json().catch(() => ({}))) as { runs?: RunRecord[] };
      if (res.ok && Array.isArray(body.runs)) setHistory(body.runs);
    } catch {
      // The history feed is non-critical; a failed load just leaves it empty.
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const run = useCallback(
    async (mode: "preview" | "live") => {
      // Never fire a real side effect by surprise: a live run of a side-effecting
      // workflow asks for explicit confirmation first.
      if (mode === "live" && COPY.hasSideEffects) {
        const ok = window.confirm(
          "This will perform real actions (for example, sending a message). Run for real now?",
        );
        if (!ok) return;
      }
      const dryRun = mode === "preview";
      setRunning(true);
      setError(null);
      setResult(undefined);
      try {
        const res = await fetchAppApi("run", {
          method: "POST",
          body: JSON.stringify({ input: COPY.needsInput ? input : undefined, dryRun }),
        });
        const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setResult(body.result);
        setResultDryRun(dryRun);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
        void loadHistory();
      }
    },
    [input, loadHistory],
  );

  // When the workflow has side effects, the main button is a safe preview and
  // "Run for real" is a separate, confirmed step. Otherwise one button runs it.
  const primaryLabel = running ? "Running…" : COPY.hasSideEffects ? "Preview" : COPY.runVerb;

  return (
    <main
      data-theme={bootstrap.shell.theme}
      className="min-h-screen bg-[var(--app-canvas)] px-6 py-6 font-sans text-foreground"
    >
      <div className="mx-auto max-w-[640px]">
        <h1 className="mb-1 text-xl font-semibold">{COPY.title}</h1>
        <p className="mb-5 text-muted-foreground">{COPY.whatItDoes}</p>

        {COPY.hasSideEffects && (
          <p className="mb-4 rounded-md border border-border bg-surface-muted px-3 py-2 text-[13px] text-muted-foreground">
            {COPY.autoTriggerNote}
          </p>
        )}

        {COPY.needsInput && (
          <label className="mb-4 block">
            <span className="mb-1.5 block text-[13px] text-muted-foreground">
              {COPY.inputLabel}
            </span>
            <textarea
              value={input}
              placeholder={COPY.inputPlaceholder}
              onChange={(e) => setInput(e.target.value)}
              rows={4}
              className="w-full resize-y rounded-md border border-input bg-background p-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
        )}

        <div className="flex items-center gap-3">
          <button
            className="inline-flex items-center rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-60"
            onClick={() => run(COPY.hasSideEffects ? "preview" : "live")}
            disabled={running}
          >
            {primaryLabel}
          </button>
          {COPY.hasSideEffects && (
            <button
              className="inline-flex items-center rounded-md border border-input bg-background px-4 py-2 font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-60"
              onClick={() => run("live")}
              disabled={running}
            >
              Run for real
            </button>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-destructive-fg">
            <p className="text-[13px]">
              Something went wrong while running this. Try again in a moment.
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer text-xs opacity-80">Details</summary>
              <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[11px] opacity-90">
                {error}
              </pre>
            </details>
          </div>
        )}
        {result !== undefined && (
          <div className="mt-4">
            <Outcome result={result} dryRun={resultDryRun} />
          </div>
        )}

        {history.length > 0 && (
          <section className="mt-7 border-t border-border pt-4">
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">Recent runs</h2>
            <ul className="divide-y divide-border-subtle">
              {history.map((r) => {
                const open = expanded === r.id;
                return (
                  <li key={r.id}>
                    <button
                      className="flex w-full items-center gap-2 py-2 text-left"
                      onClick={() => setExpanded(open ? null : r.id)}
                      aria-expanded={open}
                    >
                      <span
                        className={`size-2 shrink-0 rounded-full ${STATUS_DOT[r.status]}`}
                        aria-hidden
                      />
                      <span className="text-[13px]">{statusLabel(r)}</span>
                      {r.dryRun && (
                        <span
                          className="rounded-full bg-muted px-1.5 py-px text-[11px] text-muted-foreground"
                          title="A safe test run — no real actions were taken."
                        >
                          preview
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {timeAgo(r.startedAt)}
                      </span>
                      <span className="min-w-[44px] text-right text-xs text-subtle-foreground">
                        {formatDuration(r.durationMs)}
                      </span>
                    </button>
                    {open && (
                      <div className="pb-2.5">
                        {r.status === "error" ? (
                          <div className="rounded-md border border-destructive-border bg-destructive-bg px-3 py-2 text-destructive-fg">
                            <p className="text-[13px]">This run didn't finish.</p>
                            {r.error && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs opacity-80">
                                  Details
                                </summary>
                                <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[11px] opacity-90">
                                  {r.error}
                                </pre>
                              </details>
                            )}
                          </div>
                        ) : r.status === "running" ? (
                          <p className="text-[13px] text-muted-foreground">Still working…</p>
                        ) : (
                          <Outcome result={r.result} dryRun={r.dryRun} />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
