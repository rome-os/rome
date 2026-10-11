# App Artifact

How an app crosses from the builder that produces it to the installer that materializes it: the packed artifact and the gates on both sides of that handoff. The vocabulary callers see — [install sources](../concepts/apps.md#install-sources), [lifecycle operations](../concepts/apps.md#lifecycle-operations), the [app store](../concepts/apps.md#app-store) — lives on the app concepts and is not restated here.

## Handoff

```
app source ──build──► build output ──pack──► packed artifact ──materialize──► installed directory
```

Build runs the app's own toolchain. Pack snapshots the build output and the [manifest](../concepts/apps.md) into the packed artifact. Materialize installs the declared dependencies and commits the result to a content-addressed installed directory. The [install source](../concepts/apps.md#install-sources) decides who runs build and pack: the daemon for a source install, the publisher for a store install, and the platform build for [first-party apps](build.md#first-party-app-pre-packing). [`app-lifecycle.md`](app-lifecycle.md#ownership) decomposes the installer side.

### Invariants

- Every packed artifact carries positive proof that pack produced it. Classifying a directory as a packed artifact keys on that proof, never on the absence of source markers ([declared install mode](../concepts/apps.md#lifecycle-operations)).
- Pack is deterministic: identical source packs to an identical artifact hash. Nothing time-, host-, or process-dependent enters the artifact.
- A packed artifact never ships installed dependency modules. Materialize resolves the declared dependency graph on the install host, so native modules match the host runtime.
- A dependency the artifact does not declare does not exist after materialize. Dependency resolution is fenced from any enclosing workspace, so a reference that resolves only in the author's checkout fails here.
- Store-page metadata never enters the handoff. Pack excludes the store sidecar from the packed artifact and from every hash that addresses it, so store assets never reach an install.
- An app can publish its source in the same packed artifact. If `app.yaml#includeSource` is `true`, pack keeps the root `src/` directory. The artifact hash covers that source.

## Validation

A single strict, format-versioned schema validates the [manifest](../concepts/apps.md).

### Invariants

- The same schema runs at the pack gate and the install gate, and once more after dependency installation, before the installed directory is committed.
- An unknown manifest field is rejected, not stripped, and the declared format version must be one the build explicitly supports. Published versions are [immutable](../concepts/apps.md#app-store), so anything the gates tolerate once must be tolerated forever. Readers must support an optional field before publishers use it. Incompatible manifest changes require a new format version.
- A declared agent, action, or skill configuration is schema-validated at the gates, not merely checked for existence.
- Agent, action, and skill definition names pass the shared [artifact local-name validation](../concepts/apps.md#artifact-names-and-references) at both gates. A definition name containing `:` is rejected because the separator belongs to references.
- Format version 2 artifact references must use the canonical `<app-id>:<local-name>` form. Bare names exist only as legacy inputs and new durable references are always canonical.
- A scoped App Store id stays intact through installation and artifact qualification: `@foo/bar` plus local name `baz` becomes `@foo/bar:baz`.
- Every path the manifest declares resolves inside the artifact. A path that escapes it is rejected.
- Inside the declared app root, layout belongs to the app's build. Rome resolves what the manifest names and assumes nothing else about the structure.
