/**
 * Prose predating the gate in `check-prose.mjs`, counted per file and per
 * rule. A quarantine list, not an exception list: nothing here is blessed.
 *
 * Empty is the goal state, and the repo is there. An entry earns its place
 * only when a doc cannot be fixed in the change that trips the gate.
 *
 * Regenerate with `pnpm lint:prose --write` after fixing prose, and let the
 * diff show the counts falling. A count that only ever rises is the gate
 * working — new prose follows `docs/authoring/WRITING.md` from the start.
 */
export const BASELINE = {};
