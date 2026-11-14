# The Python and ffmpeg that script/build.py needs.
{ pkgs ? import <nixpkgs> {} }: pkgs.mkShell { packages = [ (pkgs.python3.withPackages (ps: with ps; [ pyarrow fsspec aiohttp requests pandas numpy ])) pkgs.ffmpeg-headless pkgs.curl ]; }
