# shellcheck shell=sh  # sourced into the in-container rome and user shells, no shebang
# Gives shells the PATH order rome-run-as gives the account's services: the
# account's ~/.local/bin, where its npm and uv installs land, after every other
# directory, so nothing installed there stands in for a command the image ships.
# Debian's default ~/.profile puts the directory first, so it moves to the end.
# rome-init.sh has both ~/.bashrc and ~/.profile source this file, since
# /etc/profile resets PATH for login shells before ~/.profile runs.
__rome_bin="$HOME/.local/bin"
__rome_path=":$PATH:"
while :; do
  case "$__rome_path" in
    *":$__rome_bin:"*) __rome_path="${__rome_path%%":$__rome_bin:"*}:${__rome_path#*":$__rome_bin:"}" ;;
    *) break ;;
  esac
done
__rome_path="${__rome_path#:}"
__rome_path="${__rome_path%:}"
PATH="${__rome_path:+$__rome_path:}$__rome_bin"
export PATH
unset __rome_bin __rome_path
