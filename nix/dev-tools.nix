{ pkgs, system }:

let
  platform =
    {
      aarch64-darwin = {
        biomeAsset = "darwin-arm64";
        biomeHash = "sha256-Ui/jBqzx4eVX4w34zLm+eS1Z1MAQD8/brexK741yY1s=";
        shfmtAsset = "darwin_arm64";
        shfmtHash = "sha256-2QOALgzj7LyCuYUS9VujcLDTepPz943jlPW2VwUrM90=";
        valeAsset = "macOS_arm64";
        valeHash = "sha256-oOXzCYa8BttnANrH9VD0KIDHT+ICET2uaANe0gMOW00=";
      };
      x86_64-darwin = {
        biomeAsset = "darwin-x64";
        biomeHash = "sha256-yFAe2JDW80G5geF4m58HThPnzyahscK1F23XbgXrzoM=";
        shfmtAsset = "darwin_amd64";
        shfmtHash = "sha256-wxVIaT3mWE5hZLftX7t7Sgg/LZN8qUtODd9ZqkYaheQ=";
        valeAsset = "macOS_64-bit";
        valeHash = "sha256-pDYu8Vm9m7uefPKW/UbK7s1UgeV8GQpGmIlPCoYTuEs=";
      };
      aarch64-linux = {
        biomeAsset = "linux-arm64-musl";
        biomeHash = "sha256-1X3PbCHUy4Y/zxI2FpS+AjEawc6MaLbd63HR3mWWj1A=";
        shfmtAsset = "linux_arm64";
        shfmtHash = "sha256-Xz/j+mqfdm5qGCunmpS++K/tr8V9sLGtMrD2f66XG6Q=";
        valeAsset = "Linux_arm64";
        valeHash = "sha256-YBcs0Fnm/tzPhJkOn7pqQX2LVSvqer/WF4PoyFzHPBw=";
      };
      x86_64-linux = {
        biomeAsset = "linux-x64-musl";
        biomeHash = "sha256-aVo0FkaT0HEPZlLRrS3MRe6VQWOUq3RRlE7deFY35OA=";
        shfmtAsset = "linux_amd64";
        shfmtHash = "sha256-2fuyqcM9E/R+dhjPNiqRTQKdAqbfEkBk//BP1oinReo=";
        valeAsset = "Linux_64-bit";
        valeHash = "sha256-yPnWyAVUQrx+nBIbJJjm8OP7Zw9GZebuV38Yl/dmXPY=";
      };
    }
    .${system} or (throw "unsupported Rome development system: ${system}");

  binary =
    {
      pname,
      version,
      url,
      hash,
      executable,
    }:
    pkgs.stdenvNoCC.mkDerivation {
      inherit pname version;
      src = pkgs.fetchurl { inherit url hash; };
      dontUnpack = true;
      installPhase = ''
        runHook preInstall
        install -Dm755 "$src" "$out/bin/${executable}"
        runHook postInstall
      '';
    };

  biome = binary {
    pname = "biome";
    version = "2.3.6";
    url = "https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%402.3.6/biome-${platform.biomeAsset}";
    hash = platform.biomeHash;
    executable = "biome";
  };

  pnpm = pkgs.stdenvNoCC.mkDerivation {
    pname = "pnpm";
    version = "11.6.0";
    src = pkgs.fetchurl {
      url = "https://registry.npmjs.org/pnpm/-/pnpm-11.6.0.tgz";
      hash = "sha512-mjZRgiQIDG/lFlr9z+eb+hGMKb5wPz9GKx4y7+HpjkfodQsUjggoYlCq1BE8x5k8pBPE4s1Ed1JwjC7ldRvJXw==";
    };
    nativeBuildInputs = [ pkgs.makeWrapper ];
    sourceRoot = "package";
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/pnpm" "$out/bin"
      cp -R . "$out/lib/pnpm/"
      makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/pnpm" \
        --add-flags "$out/lib/pnpm/bin/pnpm.mjs"
      makeWrapper ${pkgs.nodejs_24}/bin/node "$out/bin/pnpx" \
        --add-flags "$out/lib/pnpm/bin/pnpx.mjs"
      ln -s pnpm "$out/bin/pn"
      ln -s pnpx "$out/bin/pnx"
      runHook postInstall
    '';
  };

  shfmt = binary {
    pname = "shfmt";
    version = "3.12.0";
    url = "https://github.com/mvdan/sh/releases/download/v3.12.0/shfmt_v3.12.0_${platform.shfmtAsset}";
    hash = platform.shfmtHash;
    executable = "shfmt";
  };

  vale = pkgs.stdenvNoCC.mkDerivation {
    pname = "vale";
    version = "3.19.0";
    src = pkgs.fetchurl {
      url = "https://github.com/vale-cli/vale/releases/download/v3.19.0/vale_3.19.0_${platform.valeAsset}.tar.gz";
      hash = platform.valeHash;
    };
    nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ]
      ++ pkgs.lib.optional pkgs.stdenv.isLinux pkgs.autoPatchelfHook;
    buildInputs = pkgs.lib.optional pkgs.stdenv.isLinux pkgs.stdenv.cc.cc.lib;
    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p unpacked "$out/bin"
      tar -xzf "$src" -C unpacked
      install -m755 unpacked/vale "$out/bin/vale"
      runHook postInstall
    '';
  };
in
{
  inherit biome pnpm shfmt vale;
}
