#!/usr/bin/env bash
# Seeds the facts the baseline scenarios ask for into a dev stack's Concierge
# memory, before `pnpm concierge:eval --snapshot` freezes it.
# docs/concierge-eval.md#baseline
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
container="${1:-$(scripts/worktree-slug.sh)-rome-1}"

docker exec -i "$container" bash -s <<'SEED'
set -euo pipefail
memory=/rome-home/.rome/default/memory
mkdir -p "$memory/topics"
cat > "$memory/topics/health.md" <<'FACTS'
# Health

- Dentist: Dr. Weber. Next appointment: 2026-11-20 at 15:30 (check-up and cleaning).
FACTS
grep -q "topics/health.md" "$memory/MEMORY.md" ||
  sed -i 's|^## Topics$|## Topics\n\n- [Health](topics/health.md) — doctors, appointments|' "$memory/MEMORY.md"
echo "seeded $memory/topics/health.md"
SEED
