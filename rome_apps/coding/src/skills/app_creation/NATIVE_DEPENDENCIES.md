# Native Dependencies

Companion to [`REFERENCE.md` → `package.json`](./REFERENCE.md#packagejson). Read this before adding a dependency with a build script, or when an install fails with `gyp ERR!`, `not found: make`, or `ERR_PNPM_IGNORED_BUILDS`.

## Where dependencies install

Rome installs an app's dependencies inside the Rome container, as the `rome` account, in two steps:

1. A source install runs `pnpm install` and then the app's `build` script in the app repo. Dev dependencies install in this step too.
2. Every install, including an App Store install, runs `pnpm install --prod` for the packed artifact.

Both steps run every build script that the app's `pnpm-workspace.yaml` approves under `allowBuilds`. A build script that compiles C or C++ fails, because the container has Python 3 but no `make` and no C or C++ compiler. `command -v make g++` prints nothing.

The `rome` account cannot install system packages. Its `sudo` rights cover two Rome maintenance commands and nothing else.

## What a Rome upgrade keeps

A Rome upgrade replaces the container with a new one built from the new image. Only the volumes carry over.

| Path | After an upgrade |
|---|---|
| `/home/rome`: app repos, installed apps, app data, the database, the pnpm store, `~/.cache` | Kept |
| `/home/user` | Kept |
| `/app` | Rome's own code, replaced by the new image. `/app/memory` is kept. |
| System directories such as `/usr`, `/opt`, and `/etc`, including anything installed with `apt-get` or `npm install -g` | Replaced by the new image |

Rome publishes a new image every weekday, often more than once a day ([release schedule](https://github.com/rome-os/rome/blob/main/docs/releases.md#scheduled-patch-releases)). An instance upgrades at these times:

- **Rome Cloud:** when the guardian starts the upgrade under Settings → System. Instances with automatic upgrades also check at 3:00 in the guardian's time zone, then upgrade after a countdown the guardian can postpone.
- **Self-hosted:** when the operator pulls a new image and recreates the container, for example by running the quickstart script again.

An installed app keeps its dependencies across Rome upgrades. Rome installs them again whenever the app is installed again, which includes each reinstall after an edit and each App Store update. So an app's native code must install on the stock image every time.

## Choose how to ship native code

Try these options in order.

### 1. Use a dependency without native code

- For SQLite, use the [app database](./REFERENCE.md#database--migrations) for app data, and `node:sqlite` (built into Node 24) for tests and scripts.
- Prefer a pure JavaScript or WebAssembly package over a native one.
- Do not add a driver the app does not use. Drizzle lists `better-sqlite3` and other drivers as optional peers.
- Treat a native test-only dependency like a runtime one. Dev dependencies install during a source install, so its build script runs there.

### 2. Decline builds the package does not need

Some packages ship compiled binaries inside the npm package and need their build only on platforms without one. If the package ships a binary for the instance, decline its build:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  better-sqlite3: false
```

better-sqlite3 13 ships `prebuilds/linux-x64.node` and `prebuilds/linux-arm64.node`, so it loads with its build declined. Approving its build fails the install. pnpm runs `node-gyp rebuild` for any approved package that has a `binding.gyp` and no install script, and node-gyp needs `make`. The app template declines `esbuild` the same way.

Record a decision for every dependency with a build script. pnpm fails the install with `ERR_PNPM_IGNORED_BUILDS` when one is missing.

To check what a package ships, run `npm pack <package>@<version> --dry-run` and look for `.node` files under `prebuilds/linux-<arch>`. `uname -m` prints the architecture: `x86_64` is `x64`, and `aarch64` is `arm64`.

### 3. Approve builds that load a prebuilt binary

Approve a build only when its install script uses a prebuilt binary for the instance and compiles only as a fallback:

- An install script of `node-gyp-build` loads a binary from the package's `prebuilds/` directory. classic-level 1.4.1 installs this way on both architectures.
- An install script that starts with `prebuild-install` downloads a binary from the package's releases, so the instance must reach the download host.

If no binary matches the instance's architecture, the script compiles and the install fails. bufferutil 4.0.9 ships a `linux-x64` binary and no `linux-arm64` binary, so it installs on x64 and fails on arm64.

### 4. Vendor a binary your code loads

If no package ships a binary for the instance, build the `.node` file once on another machine and commit it to the app repo.

1. Build the addon with N-API. A non-N-API addon loads only on the Node major version it was built for. A Rome upgrade can move to a new Node major.
2. Build it in the `node:24-bookworm` Docker image, which has the compilers. Pass `--platform linux/amd64` or `--platform linux/arm64` to match the instance. Use a machine with Docker, such as the guardian's computer or a CI runner.
3. Commit the file outside `node_modules`, for example as `native/<name>.node`. Pack and install both drop `node_modules`.
4. Copy the file into the `appRoot` directory in the `build` script, for example `"build": "rome build && mkdir -p dist/native && cp native/*.node dist/native/"`. Pack keeps only the `appRoot` directory and a few root files such as `package.json`.
5. Load the file with `createRequire(import.meta.url)` and a path that starts from the loading module's directory.

### 5. Self-hosted only: extend the image

A self-hosted instance can run an image that adds the compilers. Rome Cloud runs only the stock image.

```dockerfile
ARG ROME_VERSION
FROM yunfanye/rome:${ROME_VERSION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && rm -rf /var/lib/apt/lists/*
```

1. Build the image for the Rome version you run: `docker build --build-arg ROME_VERSION=<version> -t rome-native:<version> .`
2. Start Rome from it. Pass `--image rome-native:<version> --no-pull` to the quickstart script, or set `image:` in the Compose file.
3. Repeat both steps for every Rome upgrade. The quickstart script without `--image` pulls the stock image, which has no compiler.

On the first build for each Node version, node-gyp downloads the Node headers from nodejs.org and caches them under `~/.cache/node-gyp`.

## What does not work

- **Installing a compiler with `apt-get`.** The `rome` account cannot run it, and the next upgrade replaces the system directories it writes to.
- **Installing a toolchain under `/home/rome`.** It survives upgrades, but Rome runs installs with the image's fixed `PATH`, which has no directory under `/home`. Rome has no setting that changes the install environment.
- **Shipping a prebuilt `node_modules`.** Pack and install both drop `node_modules` and install the declared dependencies again.
- **A startup script.** Rome runs no user script when the container starts. An app's `app-started` hook runs as `rome`, like the rest of the app's code.
