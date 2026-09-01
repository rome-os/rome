{
  description = "Rome development shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # Host-native tooling for ad-hoc scripts and editor integrations. The
      # Rome dev runtime and the observability stack run as containers — see
      # scripts/dev-up.sh.
      devShells = forAllSystems (pkgs: {
        # mkShell (not mkShellNoCC) so the shell carries a C/C++ toolchain:
        # node-pty publishes prebuilds for darwin and win32 only, so on Linux
        # `pnpm install` must compile it with node-gyp. Without cc the install
        # fails outright on a cold tree — warm trees only survive because pnpm
        # replays a cached build.
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
            pkgs.git
            # node-gyp drives the build with python3 + make + a compiler. make
            # comes from stdenv and cc from mkShell; python3 has to be asked
            # for by name, and node-gyp checks for it first, so a missing
            # compiler surfaces as a confusing "PythonFinder.fail".
            pkgs.python3
            # (chromium is appended below — Linux only.)
            # Biome (lint + format). The npm `@biomejs/biome` binary is a
            # generic-linux dynamically-linked executable that NixOS can't run
            # (CI/containers use it fine), so vendor the nixpkgs build for host
            # editor integration and manual `biome check .` / `biome format`.
            # Keep this pinned to the same version as the @biomejs/biome devDep.
            pkgs.biome
            pkgs.agent-browser
            # scripts/dev-up.sh (`pnpm dev:all`) shells out to curl for its
            # readiness probes; setup.sh uses openssl for local secrets.
            # macOS ships both system-wide, but a clean Linux/nix shell has
            # neither — without them dev:all hangs at the obs gate (240s silent
            # curl loop). Vendor them so the devShell is self-sufficient on
            # every host.
            pkgs.curl
            pkgs.openssl
            # Shell-script linting (`pnpm lint:sh` / `scripts/lint-shell.sh`):
            # shellcheck for static analysis, shfmt for formatting. CI installs
            # its own pinned binaries — see .github/workflows/ci.yml.
            pkgs.shellcheck
            pkgs.shfmt
            # Prose linting for docs/ and for comments in .ts/.tsx sources
            # (`pnpm lint:prose`). Vale reads the vendored style in
            # .vale/styles/Rome, which encodes the machine-checkable rules from
            # docs/authoring/WRITING.md.
            #
            # This lags CI on purpose, and it is the one tool here that does.
            # CI pins 3.19.0 for a line-mapping fix that matters for comments
            # inside long block comments; nixpkgs carries 3.14.1, which reports
            # a drifted line for a few of them. The verdict is identical either
            # way — the baseline counts alerts per file and per rule, not per
            # line — so a host run still says pass or fail correctly, and only
            # the line a reader jumps to can be off. Drop this note when
            # nixpkgs reaches 3.19.0.
            pkgs.vale
            # Vultr's API CLI, for ad-hoc host-side infrastructure work. It
            # reads VULTR_API_KEY from the environment — keep the key out of
            # the repo and out of the shell definition.
            pkgs.vultr-cli
            # NOTE: `pnpm dev:all` needs no host-side mutagen — the rome-sync
            # sidecar (infra/rome-sync) bakes mutagen into its image and runs the
            # source-sync session inside the container.
            # NOTE: the `docker` CLI is intentionally NOT vendored here. It is
            # host-coupled — it must talk to the local engine's socket, which
            # differs per host (OrbStack's context on macOS; the Docker daemon
            # socket on a Linux host). Vendoring a generic docker-client can
            # shadow the host's CLI and point at the wrong socket. So the engine
            # CLI comes from the host.
          ]
          # Headless browser backing `agent-browser` (UI smoke checks /
          # screenshots of the dev stack). agent-browser ships no browser and a
          # clean nix/Linux host has none, so it can't auto-launch; vendor
          # chromium and point it there with
          # `agent-browser --executable-path "$(command -v chromium)" …`.
          # Linux-only: on Darwin the chromium build is unsupported/broken, and
          # macOS hosts fall back to a system browser.
          ++ nixpkgs.lib.optional pkgs.stdenv.isLinux pkgs.chromium;
        };
      });
    };
}
