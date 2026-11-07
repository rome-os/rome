#!/command/with-contenv bash
# shellcheck shell=bash
# The `up` of the wait-for-rome oneshot, which the desktop and init-tools depend
# on so they do not compete with Rome's boot for CPU. Returns once Rome answers
# healthy, once the Rome daemon goes away, or after
# ROME_DEFER_UNTIL_HEALTHY_SECONDS (default 120, at most 150), whichever comes
# first. Always exits 0: a Rome that never comes up must not keep the desktop
# down. The oneshot's timeout-up (180 s) covers the cap plus one slow poll.
#
# With ROME_ENABLE_CDP_AUTOMATION on, it returns at once: capability discovery
# probes Chrome while Rome boots, so Chrome must not wait for Rome.

[ "${ROME_ENABLE_CDP_AUTOMATION:-false}" = "true" ] && exit 0

limit="${ROME_DEFER_UNTIL_HEALTHY_SECONDS:-120}"
[[ "$limit" =~ ^[0-9]+$ ]] || limit=120
[ "$limit" -gt 150 ] && limit=150

rome_url="http://127.0.0.1:${INTERNAL_API_PORT:-4141}/api/health"
daemon_url="http://127.0.0.1:${HEALTH_DAEMON_PORT:-9368}/health"
daemon_seen=0
daemon_misses=0
deadline=$((SECONDS + limit))
while [ "$SECONDS" -lt "$deadline" ]; do
  if curl --fail --silent --output /dev/null --max-time 2 "$rome_url"; then
    exit 0
  fi
  # The daemon answers its own health route, 503 included, for as long as it
  # runs. Once it has answered, three misses in a row mean it is gone.
  if curl --silent --output /dev/null --max-time 1 "$daemon_url"; then
    daemon_seen=1
    daemon_misses=0
  elif [ "$daemon_seen" = 1 ]; then
    daemon_misses=$((daemon_misses + 1))
    if [ "$daemon_misses" -ge 3 ]; then
      echo "The Rome daemon stopped answering; starting the desktop without waiting."
      exit 0
    fi
  fi
  sleep 0.5
done

echo "Rome is not healthy after ${limit}s; starting the desktop anyway."
exit 0
