import type { ReactNode } from "react";

/**
 * The shape of a UX audit report.
 *
 * Authoring a new audit means writing one data file against these types plus a
 * component per reproduction — the page chrome, filtering, triage and prompt
 * export in `Report.tsx` are fixed. Prose fields take a light inline syntax so
 * the same string renders as HTML and exports as Markdown without a second
 * copy: `backticks` become code, **stars** become bold.
 */

/** `block` findings are mechanical and near-certain; `warn` involves judgment. */
export type Severity = "block" | "warn";

/** Which half of a reproduction is showing: the defect, or the fix. */
export type ReproMode = "shipped" | "fixed";

export interface Evidence {
  /** Repo-relative path plus line or range — `packages/web/src/pages/Foo.tsx:286-300`. */
  where: string;
  /** Smallest snippet that shows the violation. */
  code: string;
}

export interface Repro {
  /** Shown in the frame's chrome bar: the route or surface being reproduced. */
  label: string;
  /** One line telling the reader which interaction exposes the defect. */
  hint?: string;
  /**
   * Renders the surface for one mode. Reproductions MUST be built from real
   * `@rome-os/ui` primitives and semantic tokens — a hand-drawn lookalike
   * silently stops matching the product the first time the kit changes.
   * Anything with internal state belongs in its own component.
   */
  render: (mode: ReproMode) => ReactNode;
}

export interface Finding {
  /** Stable slug. Triage decisions persist against it, so don't renumber. */
  id: string;
  severity: Severity;
  /** Rule id from the audit ruleset, e.g. `state-completeness`. */
  rule: string;
  /** Surface label — doubles as the filter value, so keep the set small. */
  surface: string;
  title: string;
  /** Why it's wrong, tied to this code. One or two paragraphs. */
  why: string[];
  evidence: Evidence;
  /** The concrete change, in terms of this codebase. */
  fix: string;
  repro?: Repro;
}

/** Something the design gets right that a fix must not regress. */
export interface Note {
  lead: string;
  body: string;
}

export interface AuditReport {
  /** Route or surface under audit — rendered in the title. */
  route: string;
  headline: string;
  standfirst: string;
  /** Opening assessment. Lead with the pattern, not the list. */
  summary: string[];
  findings: Finding[];
  keep: Note[];
  /** Candidates examined and deliberately not flagged, with the reason. */
  declined: Note[];
  /** Repo conventions appended to the exported prompt. */
  groundRules: string[];
  footer: string;
}
