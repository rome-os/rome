#!/command/with-contenv bash
# shellcheck shell=bash
# Returns once Rome answers healthy, so the services that call it do not compete
# with Rome's boot for CPU. After ROME_DEFER_UNTIL_HEALTHY_SECONDS (default 120)
# it returns anyway, so a Rome that never comes up cannot hold them back. Always
# exits 0. Only the first wait in a container blocks: later calls, such as a
# restarted service, return at once.

marker=/run/rome-boot-healthy
[ -e "$marker" ] && exit 0

limit="${ROME_DEFER_UNTIL_HEALTHY_SECONDS:-120}"
url="http://127.0.0.1:${INTERNAL_API_PORT:-4141}/api/health"
deadline=$((SECONDS + limit))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl --fail --silent --output /dev/null --max-time 2 "$url"; then
    touch "$marker"
    exit 0
  fi
  sleep 0.5
done

echo "Rome is not healthy after ${limit}s; starting anyway."
touch "$marker"
exit 0
