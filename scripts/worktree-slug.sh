#!/usr/bin/env bash
# Emit a DNS-label-safe slug for the current git worktree.
#
# Rule (Worktree Isolation): the current git branch name,
# lowercased, non-[a-z0-9] runs collapsed to a single hyphen, leading and
# trailing hyphens stripped, truncated to 63 chars. The branch is the stable
# per-worktree identity; the worktree-root basename is the fallback for a
# detached HEAD (no branch to name the stack after).
#
# A non-empty ROME_DEV_SLUG replaces the branch, under the same rule, so one
# checkout keeps one stack and one <slug>.rome.localhost address across
# branches. Pass it per command (DEVELOPMENT.md).
#
# Consumers:
#   - scripts/dev-up.sh  → Compose project name + Traefik subdomain.
#   - ./r                → locates the running Rome container.
# Keep the output identical across callers.
set -euo pipefail

slugify() {
  printf '%s' "$1" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' |
    cut -c1-63
}

if [ -n "${ROME_DEV_SLUG:-}" ]; then
  slug="$(slugify "$ROME_DEV_SLUG")"
  # An empty slug names no stack, and dev-up.sh would then mount the whole
  # ~/.rome-worktrees as this stack's home.
  if [ -z "$slug" ]; then
    echo "worktree-slug: ROME_DEV_SLUG=\"$ROME_DEV_SLUG\" has no letters or digits." >&2
    exit 1
  fi
  printf '%s\n' "$slug"
  exit 0
fi

# `--show-current` is empty on a detached HEAD; fall back to the worktree dir.
branch="$(git branch --show-current)"
if [ -z "$branch" ]; then
  branch="$(basename "$(git rev-parse --show-toplevel)")"
fi

slugify "$branch"
