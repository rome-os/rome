#!/usr/bin/env bash
# restart.sh <label>: restart this worktree's dev Rome (and its Chrome sidecar, which
# shares the rome container's network), wait for boot, print the prototype log lines.
S=prototype-webchat-default-agent-replay; C=$S-rome-1
cd ~/workspace/wda-proto-replay; P=scripts/prototype-webchat-default-agent/dev-all.sh
echo "== restart [$1]"; $P scenarios state
since=$(date -u +%FT%TZ); echo "restart at $since"
docker restart "$C" >/dev/null
# The Chrome sidecar shares the rome container's network, so it must restart too.
# Its /tmp survives a restart and a stale X lock keeps Chrome from starting.
docker exec "$S-chrome-1" sh -c 'rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 ~/.rome/chrome-profile/Singleton*' 2>/dev/null
docker restart "$S-chrome-1" >/dev/null
for i in $(seq 1 150); do docker logs --since "$since" "$C" 2>&1 | grep -q '"Rome started"' && break; sleep 2; done
docker logs --since "$since" "$C" 2>&1 | grep -E 'wda_proto|agent reload failed|"api listening"|first-party apps converged|"Rome started"' | sed -E 's/"rome.log.source":"rome",//' | cut -c1-330
$P scenarios state
