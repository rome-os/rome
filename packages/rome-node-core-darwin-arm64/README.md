# Rome Node Core (macOS arm64)

`@rome-os/node-core-darwin-arm64` bundles the signed Apple Silicon macOS
`Rome Computer Use.app` helper for [`@rome-os/node-core`](../rome-node-core/README.md).

It is declared as an optional dependency of `@rome-os/node-core` with
`"os": ["darwin"]` and `"cpu": ["arm64"]`, so npm, pnpm, and yarn install it
only on Apple Silicon Macs and skip it on Linux, Windows, and Intel Macs.

See [`@rome-os/node-core`](../rome-node-core/README.md#shared-macos-computer-use)
and [the native helper documentation](../rome-node-core/native/README.md) for
build, signing, notarization, and permission details.
