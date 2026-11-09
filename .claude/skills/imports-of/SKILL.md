---
name: imports-of
description: Find what a set of TypeScript files imports and what imports them, grouped by folder. Use when deciding where files belong, which import rules a folder can take, or what depends on code before changing it.
---

# Imports of a set of files

Goal end-state: every import crossing the edge of the set is known, by the folder on the other side, from one run of `pnpm imports-of <files or folders>` ([`scripts/imports-of.ts`](../../../scripts/imports-of.ts)) rather than from reading files one at a time.

The report resolves imports as `pnpm lint:imports` does, so it counts type-only imports and tests, and a folder it names as importing nothing from the set breaks no import rule in that direction.

A folder is a place in the tree, not a decision. Which crossings are wrong and which rules a boundary takes are judged against the domain model, not against the counts.
