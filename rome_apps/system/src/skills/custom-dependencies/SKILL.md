---
name: custom-dependencies
description: Install software that Rome does not ship, such as a system package, CLI tool, language runtime, Python or global npm package, or an app dependency with native code, so it keeps working after Rome upgrades. Use when the guardian asks to install a tool or package in Rome, when `apt-get`, `sudo`, `pip`, or `npm install -g` fails, or when an app install fails with a native-build hint or `ERR_PNPM_IGNORED_BUILDS`.
---

# Custom dependencies

## The rules

- Rome runs as the `rome` account. Its `sudo` rights cover two Rome maintenance commands and nothing else, so it cannot run `apt-get` or install into `/usr`.
- A Rome upgrade replaces the container. Of the files you can change, only those under `/home/rome`, `/home/user`, and `/app/memory` carry over. `/home/rome` is the home directory of `rome`.
- Rome's processes, app installs, app code, and the `rome` and `user` shells have `~/.local/bin` at the end of `PATH`. Commands there run by name, and an image command wins any name clash.

Install custom software under `/home/rome`. Commands in `~/.local/bin` run by name. Anything elsewhere, such as `~/.local/go/bin/go`, needs a symlink into `~/.local/bin` or its absolute path. Rome and its apps see only `/home/rome/.local/bin`, so a tool the `user` account installs over SSH is not on their `PATH`.

## What a Rome upgrade keeps

| Path | After an upgrade |
|---|---|
| `/home/rome`: `~/.local`, `~/.cache`, `~/.npmrc`, the shell profiles, app repos, installed apps, app data, the database, the pnpm store | Kept |
| `/home/user` | Kept |
| `/app` | Rome's own code, replaced by the new image. `/app/memory` is kept. |
| System directories such as `/usr`, `/opt`, and `/etc`, including anything installed with `apt-get` | Replaced by the new image, except Rome's SSH host keys and Tailscale state |

Rome publishes a new image every weekday on a schedule, plus manual releases ([release schedule](https://github.com/rome-os/rome/blob/main/docs/releases.md#scheduled-patch-releases)). An instance upgrades at these times:

- **Rome Cloud:** when the guardian starts the upgrade under Settings → System. Instances with automatic upgrades also check at 3:00 in the guardian's time zone, then upgrade after a countdown the guardian can postpone.
- **Self-hosted:** when the operator pulls a new image and recreates the container, for example by running the quickstart script again.

## Where each kind of dependency goes

`dpkg --print-architecture` prints the architecture to download for, `amd64` or `arm64`. Node packages name `amd64` as `x64`.

### CLI tools and language runtimes

Download a static binary or the official Linux tarball, and unpack it under `~/.local`:

```bash
mkdir -p ~/.local/bin
rm -rf ~/.local/go
curl -fsSL "https://go.dev/dl/go<version>.linux-$(dpkg --print-architecture).tar.gz" | tar -xz -C ~/.local
ln -sf ~/.local/go/bin/go ~/.local/bin/
go version
```

A tool that links against the image's system libraries can break when an upgrade changes them. Prefer a static build.

### Python packages and tools

The image's Python 3 has no `pip` and no `ensurepip`, and Debian marks it as externally managed. Use [uv](https://docs.astral.sh/uv/), which installs into `~/.local/bin` and keeps its Pythons and tools under `~/.local/share/uv`. The image configures uv to use only the Pythons it installs there, so its environments survive upgrades.

```bash
curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
uv tool install httpie                                 # a CLI tool → ~/.local/bin/http
uv venv ~/.venvs/work                                  # an environment; add --python <version> to pick one
uv pip install --python ~/.venvs/work/bin/python requests
```

### Global npm packages

Rome sets npm's global prefix to `~/.local` in `~/.npmrc` unless the file already sets one, so `npm install -g <package>` puts its commands in `~/.local/bin`.

Global packages run on the image's Node. A global package with native code can stop loading when an upgrade moves to a new Node major version.

### System packages

The stock image has no persistent way to add an `apt` package. Use one of these instead:

- A static build of the tool, installed as in [CLI tools and language runtimes](#cli-tools-and-language-runtimes).
- A package that bundles the binary, from npm or from PyPI through uv.
- On a self-hosted instance, [an extended image](#self-hosted-extend-the-image).

### App dependencies

Declare every dependency an app uses in its `package.json`. Rome installs it with the app, and the installed copy stays in place across upgrades. Anything the app finds only under `/home/rome` exists on this instance alone, so a shared or published app that relies on it breaks elsewhere.

A dependency with native code needs the steps in [App dependencies with native code](#app-dependencies-with-native-code).

## App dependencies with native code

Rome installs an app's dependencies inside the container, as `rome`, in two steps:

1. A source install runs `pnpm install` and then the app's `build` script in the app repo. Dev dependencies install in this step too.
2. Every install of an app with runtime dependencies, including an App Store install, runs `pnpm install --prod` for the packed artifact.

Both steps run every build script that the app's `pnpm-workspace.yaml` approves under `allowBuilds`. A build that compiles C or C++ fails, because the image has no `make` and no C or C++ compiler. The failed install ends with a hint that names the package. A `make` or compiler in `~/.local/bin` would be found, but it exists only on this instance. The app would still fail on the stock image and for anyone who installs it from the App Store, so do not rely on one. Rome runs step 2 again for every new version of the app, including each App Store update. The app must install on the stock image every time. Step 2 reuses the installed copy when the packed artifact has not changed. So a successful reinstall of an unchanged app does not prove that an install fix works.

Try these options in order.

### 1. Use a dependency without native code

- For SQLite, use the app database for app data (`coding:app_creation` → `REFERENCE.md`), and `node:sqlite` for tests and scripts.
- Prefer a pure JavaScript or WebAssembly package over a native one.
- Do not add a driver the app does not use. Drizzle lists `better-sqlite3` and other drivers as optional peers.
- Treat a native test-only dependency like a runtime one. Dev dependencies install during a source install, so its build runs there.

### 2. Decline builds the package does not need

Some packages ship compiled binaries inside the npm package and need their build only on platforms without one. If the package ships a binary for the instance, decline its build:

```yaml
# pnpm-workspace.yaml
allowBuilds:
  better-sqlite3: false
```

better-sqlite3 13.0.3 and later ship `prebuilds/linux-x64.node` and `prebuilds/linux-arm64.node`, so they load with the build declined. Approving the build fails the install. pnpm runs `node-gyp rebuild` for any approved package that has a `binding.gyp` and no install script, and node-gyp needs `make`. The app template declines `esbuild` the same way.

A declined build can install cleanly and still fail when the app loads the package:

- better-sqlite3 12.x ships no binary. Its install script runs `prebuild-install`, so approve the build instead, as in option 3. Declined, it fails at runtime with `Could not locate the bindings file`.
- better-sqlite3 13.0.0 to 13.0.2 ship an arm64 binary that needs glibc 2.38. The image has glibc 2.36, so it fails on arm64 with an error that `GLIBC_2.38` was not found.

After declining a build, run code that uses the package once in the Rome container, for example open a database.

Record a decision for every dependency with a build script. pnpm fails the install with `ERR_PNPM_IGNORED_BUILDS` when one is missing.

To check what a package ships, run `npm pack <package>@<version> --dry-run` and look for `.node` files under `prebuilds/linux-<arch>`. `ldd --version` prints the image's glibc version.

### 3. Approve builds that load a prebuilt binary

Approve a build only when its install script uses a prebuilt binary for the instance and compiles only as a fallback:

- An install script of `node-gyp-build` loads a binary from the package's `prebuilds/` directory. classic-level 1.4.1 installs this way on both architectures.
- An install script that starts with `prebuild-install` downloads a binary from the package's releases, so the instance must reach the download host.

If no binary matches the instance's architecture, the script compiles and the install fails. bufferutil 4.0.9 ships a `linux-x64` binary and no `linux-arm64` binary, so it installs on x64 and fails on arm64.

Prefer packages whose binaries use N-API, which usually have `napi` in the file name. A binary built for one Node ABI stops loading after a Rome upgrade moves to a new Node major version. The binary that `prebuild-install` downloads for better-sqlite3 12.x is one. Reinstalling the unchanged app reuses that binary. Release a new version of the app to install a matching one.

### 4. Vendor a binary the app's code loads

If no package ships a binary for the instance, build the `.node` file once on another machine and commit it to the app repo.

1. Build the addon with N-API. A non-N-API addon loads only on the Node major version it was built for. A Rome upgrade can move to a new Node major.
2. Build it in the `node:24-bookworm` Docker image, which has the compilers, once with `--platform linux/amd64` and once with `--platform linux/arm64`. Use a machine with Docker, such as the guardian's computer or a CI runner. A build for one architecture is enough only for an app that stays on this instance. A shared or published app runs on both.
3. Commit the files under `src/`, for example as `src/native/<name>-linux-x64.node` and `src/native/<name>-linux-arm64.node`. `rome build` copies the files under `src/` into the `appRoot` directory, except `.ts`, `.tsx`, and `.css` files and `src/web/`. With `includeSource: true`, the published source carries the files too, so each binary counts twice against the 50 MB App Store bundle limit.
4. Load the file for `process.arch` with `createRequire(import.meta.url)` and a path that starts from the loading module's directory. The same path works from `src/` and from the built output.

### 5. On a self-hosted instance, extend the image

[An extended image](#self-hosted-extend-the-image) with `make g++` lets approved builds compile.

## Self-hosted: extend the image

A self-hosted instance can run an image that adds `apt` packages. Rome Cloud runs only the stock image.

```dockerfile
ARG ROME_VERSION
FROM yunfanye/rome:${ROME_VERSION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && rm -rf /var/lib/apt/lists/*
```

1. Replace `make g++` with the packages you need.
2. Build the image for the Rome version you run: `docker build --build-arg ROME_VERSION=<version> -t rome-custom:<version> .`
3. Start Rome from it. Pass `--image rome-custom:<version> --no-pull` to the quickstart script, or set `image:` in the Compose file.
4. Repeat steps 2 and 3 for every Rome upgrade. The quickstart script without `--image` pulls the stock image.

On the first native build for each Node version, node-gyp downloads the Node headers from nodejs.org and caches them under `~/.cache/node-gyp`.

## Host execution

If the guardian has enabled host execution, `system:execute_root_script` runs a root script on the Linux VM that hosts Rome. Software it installs there survives Rome upgrades, because an upgrade replaces only the container. Rome's processes inside the container cannot run that software. Only host jobs can.

## What does not work

- **`apt-get install` or `dpkg -i`.** Both need root, and `rome` has no general `sudo`. An upgrade also replaces the system directories they write to.
- **Writing into `/app`.** `rome` can write there, but an upgrade replaces the files.
- **Shipping a prebuilt `node_modules` with an app.** Pack and install both drop `node_modules` and install the declared dependencies again.
- **A startup script.** Rome runs no user script when the container starts. An app's `app-started` hook runs as `rome`, like the rest of the app's code.
