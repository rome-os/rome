{
  description = "Rome development and CI environments";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    # flake-parts pulls its own nixpkgs.lib by default, which adds a second
    # fetched input that can drift from the nixpkgs pinned above. Follow it so
    # the lib always matches the packages the shells are built from.
    flake-parts.inputs.nixpkgs-lib.follows = "nixpkgs";
  };

  outputs =
    inputs@{
      flake-parts,
      nixpkgs,
      ...
    }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];

      perSystem =
        { pkgs, system, ... }:
        let
          tools = import ./nix/dev-tools.nix { inherit pkgs system; };
          ciPackages = [
            pkgs.nodejs_24
            tools.pnpm
            pkgs.git
            pkgs.gh
            pkgs.jq
            pkgs.python3
            pkgs.gnumake
            pkgs.stdenv.cc
            pkgs.pkg-config
            tools.biome
            pkgs.curl
            pkgs.openssl
            pkgs.shellcheck
            tools.shfmt
            tools.vale
          ];
          # No job that enters the CI shell runs either: packages/host-helper is
          # built by host-helper.yml, which brings its own Go, and the
          # workflows that need LFS objects fetch them through
          # actions/checkout. Moving them here takes 220 MiB off the closure
          # every CI job restores, and developers still get both.
          developerPackages = [
            pkgs.agent-browser
            pkgs.vultr-cli
            pkgs.go
            pkgs.git-lfs
          ] ++ nixpkgs.lib.optional pkgs.stdenv.isLinux pkgs.chromium;
          mkShell = packages: pkgs.mkShell { inherit packages; };
        in
        {
          devShells = {
            default = mkShell (ciPackages ++ developerPackages);
            ci = mkShell ciPackages;
          };

          checks.toolchain = pkgs.runCommand "rome-toolchain-check" {
            nativeBuildInputs = ciPackages;
          } ''
            export HOME="$TMPDIR"
            for command in git gh jq python3 make cc pkg-config curl openssl; do
              command -v "$command" >/dev/null
            done
            test "$(node --version)" = "v${pkgs.nodejs_24.version}"
            test "$(pnpm --version)" = "${tools.pnpm.version}"
            test "$(biome --version | awk '{ print $2 }')" = "${tools.biome.version}"
            test "$(shfmt --version)" = "v${tools.shfmt.version}"
            test "$(vale --version)" = "vale version ${tools.vale.version}"
            test "$(shellcheck --version | awk '/version:/ { print $2 }')" = "${pkgs.shellcheck.version}"

            # pnpm reads `packageManager` and downloads that version at runtime
            # when it differs from the one on PATH, so a bump there without a
            # bump in nix/dev-tools.nix silently runs a pnpm the flake never
            # pinned. Biome's `$schema` decides which rule set the config is
            # validated against. Both are copies of a version declared above.
            grep -qF '"packageManager": "pnpm@${tools.pnpm.version}"' ${./package.json}
            grep -qF '/schemas/${tools.biome.version}/schema.json' ${./biome.json}
            touch "$out"
          '';
        };
    };
}
