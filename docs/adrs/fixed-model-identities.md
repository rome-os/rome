# Model choices keep complete native identities

- **Status**: Accepted
- **Date**: 2026-11-25
- **Concept**: [model selection](../domains/agents.md#model-selection)

## Context

A menu choice, its translated name and the ID sent to a provider can name different versions. A choice that outlives a catalog update must not move to a newer model merely because its stored name omits the version.

## Decision

An exact choice is a provider and the complete native model ID. The existing `largeModelSelection` field carries one provider-qualified key, such as `anthropic/claude-opus-4-8[1m]`, in requests, responses and storage. No second API representation is needed. A native ID keeps its punctuation, date and context suffix. Only its provider adapter interprets provider-specific configuration.

The shared `@rome/api-types/models` catalog supplies choices and display names to core, the dashboard and its mock. Display names never route requests. The catalog has no models.dev or discovery dependency. Auto and agent tiers remain resolution strategies, not exact model aliases.

A frozen compatibility table translates known legacy menu choices to their original targets. It is not used to interpret native model IDs. A new menu choice of `opus`, for example, is rejected rather than treated as a floating alias. Context variants do not match each other when a runtime model is looked up in the catalog.

Startup migration rewrites only known chat choices and the corresponding default preference. Unknown saved choices remain unchanged and fail closed rather than becoming Auto. Successful-turn model records, usage attribution and provider transcripts remain unchanged. A saved choice with missing provenance is not promoted to a stronger model.

## Consequences

Older callers can submit their legacy menu choices through the compatibility reader, and newer callers send exact identities. Existing agent, tier and custom-provider native configuration remains opaque and outside the menu migration. This change neither offers floating menu aliases nor changes those configuration policies. A custom native ID displays unchanged when it has no catalog name. Account access is still checked at execution. A directory entry is not proof of access.

The data migration changes known choices in place. Downgrading to a runtime that does not understand provider-qualified keys requires an explicit reverse migration through the frozen mapping. Reverting code alone is not a safe data rollback. No migration rewrites historical model attribution.
