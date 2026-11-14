#!/usr/bin/env bash
# Runs inside the desktop container. Gives the shell the loopback addresses
# Chrome has on the devbox: the dashboard at 127.0.0.1:4780 (a secure context,
# as for Chrome), the environment's proxy at 127.0.0.1:$PROXY_PORT, and the
# debugging port, and starts the shell on an X server with no screen.
#
# env: ROME_HOST, PROXY_PORT, CDP_PORT, LANG_TAG, TREE (the built shell); the
# environment's lib at /env-lib, the recording at $MIC (its path on the devbox,
# so the command line names the same file as Chrome's).
set -euo pipefail
own_ip="$(hostname -i | cut -d' ' -f1)"
socat "TCP-LISTEN:4780,bind=127.0.0.1,fork,reuseaddr" "TCP:$ROME_HOST:8080" &
# The host reaches the proxy's control and the debugging port through the
# container's own address; the shell and the proxy listen on loopback only.
socat "TCP-LISTEN:$PROXY_PORT,bind=$own_ip,fork,reuseaddr" "TCP:127.0.0.1:$PROXY_PORT" &
socat "TCP-LISTEN:$CDP_PORT,bind=$own_ip,fork,reuseaddr" "TCP:127.0.0.1:$CDP_PORT" &
node /env-lib/proxy.mjs --port "$PROXY_PORT" &

electron="$(cd "$TREE/packages/desktop" && node -p 'require("electron")')"
cd "$TREE/packages/desktop"
export ROME_DESKTOP_DASHBOARD_URL="http://127.0.0.1:4780"
export LANGUAGE="${LANG_TAG/-/_}"
# The container has no user namespaces for Chromium's sandbox. Automation, as
# in headless Chrome, lets a client read the command line over the debugging
# port and check which recording plays.
exec xvfb-run -a "$electron" --no-sandbox \
  --remote-debugging-port="$CDP_PORT" \
  --use-fake-device-for-media-stream \
  --use-file-for-fake-audio-capture="$MIC%noloop" \
  --enable-automation \
  --proxy-server="http://127.0.0.1:$PROXY_PORT" \
  "--proxy-bypass-list=<-loopback>" \
  --lang="$LANG_TAG" \
  .
