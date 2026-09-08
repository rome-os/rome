/**
 * The ledger's vocabulary. Every fact kind is named by one rule: a participle
 * is something that happened, a noun is something somebody said.
 *
 * Facts are append-only. Nothing in this app updates or deletes one, so a
 * task's state and position are always a fold over its facts rather than a
 * column somebody has to keep true.
 */

/** Task state facts. Only a person writes the three that end a task. */
export const TASK_STATE_KINDS = ["Created", "Taken", "Completed", "Cancelled"] as const;

/** Execution facts. A worker writes two of them; the runtime writes the rest. */
export const EXECUTION_KINDS = ["Started", "Returned", "Failed", "Lost"] as const;

/** Dialogue facts. The runtime asks and reports; a person replies. */
export const DIALOGUE_KINDS = ["Question", "Report", "Reply"] as const;

export const FACT_KINDS = [...TASK_STATE_KINDS, ...EXECUTION_KINDS, ...DIALOGUE_KINDS] as const;

export type FactKind = (typeof FACT_KINDS)[number];

/** The `by` this app stamps on every fact the runtime writes itself. */
export const RUNTIME = "runtime";

/**
 * Kinds only a person may write. `reconcile` has no path to any of them, which
 * is what makes "only a person ends a task" mechanical rather than a promise.
 */
export const PERSON_KINDS: readonly FactKind[] = ["Created", "Completed", "Cancelled", "Reply"];

/** Kinds the runtime writes. The position of a task is read off the last one. */
export const RUNTIME_KINDS: readonly FactKind[] = [
  "Taken",
  "Started",
  "Lost",
  "Question",
  "Report",
];

/** Kinds that end a worker's run. A Started with none of these after it is live. */
export const WORKER_TERMINAL_KINDS: readonly FactKind[] = ["Returned", "Failed", "Lost"];

export function isPersonKind(kind: FactKind): boolean {
  return PERSON_KINDS.includes(kind);
}

export function isRuntimeKind(kind: FactKind): boolean {
  return RUNTIME_KINDS.includes(kind);
}

export function isWorkerTerminalKind(kind: FactKind): boolean {
  return WORKER_TERMINAL_KINDS.includes(kind);
}

/** Fields every fact carries, whoever wrote it. */
export interface FactHeader {
  /** The ledger's total order. Assigned by the database, never by app code. */
  seq: number;
  id: string;
  taskId: string;
  /** Who wrote it: a person's id, a worker id, or {@link RUNTIME}. */
  by: string;
  /**
   * A person's own words or the action they took, verbatim. Set on every fact
   * a person writes; the runtime and workers cite their call site instead.
   */
  source?: string;
  createdAt: Date;
}

type FactOf<K extends FactKind, P> = FactHeader & { kind: K; payload: P };

export type CreatedFact = FactOf<"Created", { brief: string }>;
export type TakenFact = FactOf<"Taken", Record<string, never>>;
export type CompletedFact = FactOf<"Completed", { reason?: string }>;
export type CancelledFact = FactOf<"Cancelled", { reason?: string }>;
export type StartedFact = FactOf<"Started", { workerId: string; prompt: string }>;
export type ReturnedFact = FactOf<"Returned", { workerId: string; reply: string }>;
export type FailedFact = FactOf<"Failed", { workerId: string; error: string }>;
export type LostFact = FactOf<"Lost", { workerId: string; why: string }>;
export type QuestionFact = FactOf<"Question", { why: string }>;
export type ReportFact = FactOf<"Report", { what: string; evidence: string }>;
export type ReplyFact = FactOf<"Reply", { text: string }>;

export type Fact =
  | CreatedFact
  | TakenFact
  | CompletedFact
  | CancelledFact
  | StartedFact
  | ReturnedFact
  | FailedFact
  | LostFact
  | QuestionFact
  | ReportFact
  | ReplyFact;

/** A fact before the ledger gives it a place in the order. */
export type NewFact = Omit<Fact, "seq" | "id" | "createdAt">;

/** The worker id carried by an execution fact, or undefined for the rest. */
export function workerIdOf(fact: Fact): string | undefined {
  switch (fact.kind) {
    case "Started":
    case "Returned":
    case "Failed":
    case "Lost":
      return fact.payload.workerId;
    default:
      return undefined;
  }
}

/** One line of a task's history, for a worker brief or a chat summary. */
export function describeFact(fact: Fact): string {
  const stamp = fact.createdAt.toISOString();
  const head = `${stamp} ${fact.kind} by ${fact.by}`;
  const body = (() => {
    switch (fact.kind) {
      case "Created":
        return fact.payload.brief;
      case "Taken":
        return "";
      case "Completed":
      case "Cancelled":
        return fact.payload.reason ?? "";
      case "Started":
        return `worker ${fact.payload.workerId}`;
      case "Returned":
        return `worker ${fact.payload.workerId}: ${fact.payload.reply}`;
      case "Failed":
        return `worker ${fact.payload.workerId}: ${fact.payload.error}`;
      case "Lost":
        return `worker ${fact.payload.workerId}: ${fact.payload.why}`;
      case "Question":
        return fact.payload.why;
      case "Report":
        return `${fact.payload.what} (evidence: ${fact.payload.evidence})`;
      case "Reply":
        return fact.payload.text;
    }
  })();
  const cited = fact.source ? ` [source: ${fact.source}]` : "";
  return body ? `${head} — ${body}${cited}` : `${head}${cited}`;
}
