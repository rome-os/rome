# Test harnesses compose through the production composition root

- **Status**: Accepted
- **Date**: 2026-09-30
- **Architecture**: [Process & Deployment — Data tier](../architecture/process.md#data-tier)

## Context

The main process wires Rome's object graph in `main()` in `packages/core/src/index.ts`. Tests need the same graph over a test database, and the common practice is a test-owned fixture factory that builds whatever a test needs. Rome had three of them, each a re-proposal of a hand-built test graph: `buildTestDeps` in `packages/core/src/test/helpers.ts`, `createTestRome` in `packages/core/src/test/kit/test-rome.ts`, and the golden-trace harness in `packages/core/src/test/golden-trace-harness.ts`.

Hand-built copies drifted. On 2026-09-30, 35 of the 47 object constructions in `buildTestDeps` were verbatim copies of lines in `index.ts`. In the 90 days before, 8 of the 13 commits that touched `index.ts` also edited `test/helpers.ts`. The main process, the action worker, `buildTestDeps`, and `createTestRome` each built one repository bundle from one database handle. Each built a different subset of it.

Every repository constructor takes the database handle and stores it, with no I/O. Boot in `main()` interleaved those constructions with I/O: seeding the instance token, applying stored app keys, recovering interrupted webchat inputs, and creating any missing sentinel persons. A test must not run those steps by accident.

## Decision

A test harness builds its object graph through the composition function the production entry point calls. It passes only what differs, such as the test database and mock channels. Only the data tier, `createDataTier`, has shipped. A domain tier beside it in `packages/core/src/composition/`, holding the `ApiDeps` modules that do not need a booted app catalog, is the declared next step.

## Alternatives

- **A fixture factory per harness, the common practice.** Rejected because each factory is a second copy of production wiring. The copies drifted into four different repository subsets, and a new dependency had to be wired once in `index.ts` and again in each copy.
- **A subset of the tier per consumer.** Rejected because each subset is a hand-maintained list per consumer, which is the drift the tier removes. Building all 17 repositories costs nothing, since each constructor only stores the handle.
- **A keyed `repos` field on `ApiDeps`.** Rejected because it renames the field every route and every test reads a repository through. That breaks the 36 test files that build their deps with `buildTestDeps`, and it changes nothing about what gets wired.
- **Record "compose, then boot" as this decision.** Rejected as the recorded decision because separating construction from start-up is common practice. It does not meet the admission rule for a record. It lives as the [composition only constructs](../architecture/process.md#invariants) invariant instead.

## Consequences

A new system repository is wired once and reaches the main process, the action worker, and every harness that composes through the tier. Tests exercise production wiring rather than a copy of it. No consumer can opt out of a repository. The tier takes nothing but the database handle, so anything that needs I/O, configuration, or a booted app catalog stays outside it.

Future diffs must respect:

- A new system repository joins `createDataTier`, not one of its consumers.
- A harness that builds a deps graph reads its repositories from the tier instead of constructing them. A unit test of one repository still constructs it directly.
- `createDataTier` stays synchronous and performs no I/O. A boot step goes in `main()` after composition.
- A tier field that `ApiDeps` also names has the type `ApiDeps` declares. The `satisfies` check in `createDataTier` enforces it at compile time.
