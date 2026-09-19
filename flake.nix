{
  description = "Rome development and CI environments";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
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
            pkgs.git-lfs
            pkgs.gh
            pkgs.jq
            pkgs.python3
            pkgs.gnumake
            pkgs.stdenv.cc
            pkgs.pkg-config
            pkgs.go
            tools.biome
            pkgs.curl
            pkgs.openssl
            pkgs.shellcheck
            tools.shfmt
            tools.vale
          ];
          developerPackages = [
            pkgs.agent-browser
            pkgs.vultr-cli
          ] ++ nixpkgs.lib.optional pkgs.stdenv.isLinux pkgs.chromium;
          mkShell = packages: pkgs.mkShell {
            inherit packages;
            ROME_DEV_ENV = "1";
          };
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
            for command in git git-lfs gh jq python3 make cc pkg-config go curl openssl; do
              command -v "$command" >/dev/null
            done
            test "$(node --version)" = "v${pkgs.nodejs_24.version}"
            test "$(pnpm --version)" = "11.6.0"
            test "$(biome --version | awk '{ print $2 }')" = "2.3.6"
            test "$(shfmt --version)" = "v3.12.0"
            test "$(vale --version)" = "vale version 3.19.0"
            test "$(shellcheck --version | awk '/version:/ { print $2 }')" = "0.11.0"
            touch "$out"
          '';
        };
    };
}
