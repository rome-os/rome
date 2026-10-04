#!/usr/bin/env node
// Runs the s6 setup and finish scripts at their supervisor boundaries.
// Usage: node scripts/docker/s6-lifecycle-smoke.mts <image>
// The image needs Node 24, gosu, s6-overlay 3.2.1.0, and tsx installed under /app.
// Build one with this Dockerfile:
//   FROM node:24
//   RUN apt-get update && apt-get install -y --no-install-recommends s6 execline gosu
//   RUN npm install --prefix /app tsx
// Also unpack the release's noarch and architecture tarballs into / and put
// /command first on PATH to test the overlay's s6-rc and supervisor versions.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const image = process.argv[2];
if (!image) {
  console.error("usage: node scripts/docker/s6-lifecycle-smoke.mts <image>");
  process.exit(2);
}

const scripts = fileURLToPath(new URL(".", import.meta.url));
const result = spawnSync(
  "docker",
  ["run", "--rm", "-i", "-v", `${scripts}:/repo:ro`, image, "bash", "-s"],
  {
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
    input: String.raw`set -eu
mkdir -p /etc/s6-overlay/scripts /tmp/oneshot-runner /tmp/daemon /run/s6/basedir/bin /run/s6-linux-init-container-results

# The setup boundary must resolve the source-mode loader from /app even when
# s6's oneshot runner starts elsewhere. The fixture only replaces setup's side effects.
cat > /etc/s6-overlay/scripts/rome-init <<'EOF'
#!/bin/sh
set -e
node --import tsx /app/generator.ts
EOF
chmod +x /etc/s6-overlay/scripts/rome-init
echo 'import { writeFileSync } from "node:fs"; writeFileSync("/tmp/setup-cwd", process.cwd());' > /app/generator.ts
cd /tmp/oneshot-runner
execlineb -Pc "$(cat /repo/s6-rc.d/init/up)"
test "$(cat /tmp/setup-cwd)" = /app
echo 'PASS: source-mode setup resolves tsx from the oneshot runner'

# halt returns before a pending s6-rc startup transition lets shutdown proceed.
# Keep the supervisor alive to expose a restart during that interval.
cat > /run/s6/basedir/bin/halt <<'EOF'
#!/bin/sh
touch /tmp/halt-requested
EOF
chmod +x /run/s6/basedir/bin/halt
cp /repo/s6-rc.d/rome-daemon/finish /tmp/daemon/finish
cat > /tmp/daemon/run <<'EOF'
#!/bin/sh
echo start >> /tmp/starts
exit 42
EOF
chmod +x /tmp/daemon/run /tmp/daemon/finish
s6-supervise /tmp/daemon &
supervisor=$!
trap 'kill "$supervisor" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do
  if [ -e /tmp/halt-requested ]; then break; fi
  sleep 0.1
done
test -e /tmp/halt-requested
sleep 3
test "$(wc -l < /tmp/starts)" -eq 1
test "$(cat /run/s6-linux-init-container-results/exitcode)" -eq 42
test "$(s6-svstat -o up /tmp/daemon)" = false
echo 'PASS: daemon stays down while shutdown is pending and retains exit 42'

# A stop requested by the supervisor must preserve the shutdown's exit code.
s6-svc -d /tmp/daemon
echo 17 > /run/s6-linux-init-container-results/exitcode
cd /tmp/daemon
./finish 0 0
test "$(cat /run/s6-linux-init-container-results/exitcode)" -eq 17
echo 'PASS: supervisor shutdown retains its own exit code'

# Compile the real Tailscale service with inert dependencies. No socket exists,
# so its real setup script stays in its best-effort readiness retry loop.
mkdir -p /tmp/ts-source/init /tmp/ts-source/tailscaled /tmp/scan /run/s6/container_environment
cp -a /repo/s6-rc.d/tailscale-setup /tmp/ts-source/
cp /repo/rome-tailscale-setup.sh /etc/s6-overlay/scripts/rome-tailscale-setup
chmod +x /etc/s6-overlay/scripts/rome-tailscale-setup
echo oneshot > /tmp/ts-source/init/type
echo /bin/true > /tmp/ts-source/init/up
echo longrun > /tmp/ts-source/tailscaled/type
printf '#!/bin/sh\nexec sleep infinity\n' > /tmp/ts-source/tailscaled/run
chmod +x /tmp/ts-source/tailscaled/run
s6-rc-compile /tmp/ts-compiled /tmp/ts-source
s6-svscan /tmp/scan > /tmp/tailscale.log 2>&1 &
scanner=$!
trap 'kill "$supervisor" "$scanner" 2>/dev/null || true' EXIT
s6-rc-init -c /tmp/ts-compiled -l /tmp/ts-live /tmp/scan
s6-rc -l /tmp/ts-live -u change tailscale-setup > /tmp/tailscale-startup.log 2>&1 &
startup=$!
for i in $(seq 1 100); do
  if grep -q 'Waiting for tailscaled' /tmp/tailscale.log /tmp/tailscale-startup.log; then break; fi
  sleep 0.1
done
grep -q 'Waiting for tailscaled' /tmp/tailscale.log /tmp/tailscale-startup.log
timeout 5 s6-rc -b -l /tmp/ts-live -da change
wait "$startup"
echo 'PASS: shutdown cancels Tailscale retries without waiting for the startup lock'

# Run the real Chrome service and wrapper with fake browser/proxy binaries.
# Killing only the wrapper must leave no live children from its old generation.
mkdir -p /tmp/chrome /tmp/browser-bin /opt/rome/scripts/docker /home/rome
cp /repo/s6-rc.d/chrome/run /tmp/chrome/run
if [ -f /repo/s6-rc.d/chrome/finish ]; then cp /repo/s6-rc.d/chrome/finish /tmp/chrome/finish; fi
cp /repo/rome-start-chrome-cdp.sh /opt/rome/scripts/docker/
cp /repo/rome-run-as.sh /usr/local/bin/rome-run-as
chmod +x /tmp/chrome/run /opt/rome/scripts/docker/rome-start-chrome-cdp.sh /usr/local/bin/rome-run-as
cat > /tmp/browser-bin/browser <<'EOF'
#!/bin/sh
echo "$$" >> /tmp/browser-generations
exec sleep infinity
EOF
cat > /tmp/browser-bin/socat <<'EOF'
#!/bin/sh
echo "$$" >> /tmp/proxy-generations
exec sleep infinity
EOF
printf '#!/bin/sh\necho ready\n' > /tmp/browser-bin/curl
chmod +x /tmp/browser-bin/*
export PATH="/tmp/browser-bin:$PATH" ROME_DOCKER_USER_MODE=root ROME_CHROME_BINARY=/tmp/browser-bin/browser ROME_CHROME_USER_AGENT=test
for name in PATH ROME_DOCKER_USER_MODE ROME_CHROME_BINARY ROME_CHROME_USER_AGENT; do
  printf '%s' "$(printenv "$name")" > "/run/s6/container_environment/$name"
done
s6-supervise /tmp/chrome &
chrome_supervisor=$!
trap 'kill "$supervisor" "$scanner" "$chrome_supervisor" 2>/dev/null || true' EXIT
for i in $(seq 1 100); do
  if [ -s /tmp/proxy-generations ]; then break; fi
  sleep 0.1
done
test -s /tmp/proxy-generations
if [ ! -s /tmp/browser-generations ]; then cat /tmp/chrome-ui.log /tmp/chrome-cdp.log; exit 1; fi
kill -KILL "$(s6-svstat -o pid /tmp/chrome)"
for i in $(seq 1 100); do
  if [ "$(wc -l < /tmp/proxy-generations)" -ge 2 ]; then break; fi
  sleep 0.1
done
test "$(wc -l < /tmp/proxy-generations)" -ge 2
for child in "$(head -1 /tmp/browser-generations)" "$(head -1 /tmp/proxy-generations)"; do
  child_state="$(ps -o stat= -p "$child" || true)"
  case "$child_state" in ''|Z*) ;; *) echo "orphan child $child survived: $child_state"; exit 1 ;; esac
done
echo 'PASS: killing the Chrome wrapper removes its old browser and proxy before recovery'

# A rome-owned symlink must not give its service a root-opened append fd.
# Model a deployment without sticky-directory symlink protection inside this fixture.
chmod 0777 /tmp
s6-svc -d /tmp/chrome
useradd -m rome
printf multi > /run/s6/container_environment/ROME_DOCKER_USER_MODE
printf ':99' > /run/s6/container_environment/DISPLAY
mkdir -p /tmp/log-services
printf '#!/bin/sh\necho service-output\n' > /tmp/log-services/writer
chmod +x /tmp/log-services/writer
for binary in openbox websockify Xtigervnc; do cp /tmp/log-services/writer "/tmp/browser-bin/$binary"; done
cp /tmp/log-services/writer /opt/rome/scripts/docker/rome-start-chrome-cdp.sh
printf '#!/bin/sh\nshift 5\nexec "$@"\n' > /tmp/browser-bin/s6-notifyoncheck
chmod +x /tmp/browser-bin/s6-notifyoncheck
echo protected > /tmp/protected-log-target
chmod 600 /tmp/protected-log-target
for pair in chrome:chrome-cdp openbox:openbox novnc:novnc xtigervnc:xtigervnc; do
  service="$(echo "$pair" | cut -d: -f1)"
  log="/tmp/$(echo "$pair" | cut -d: -f2).log"
  rm -f "$log"
  gosu rome ln -s /tmp/protected-log-target "$log"
  mkdir -p "/tmp/log-services/$service"
  (cd "/tmp/log-services/$service"; /repo/s6-rc.d/"$service"/run) || true
  test "$(cat /tmp/protected-log-target)" = protected
  rm "$log"
  (cd "/tmp/log-services/$service"; /repo/s6-rc.d/"$service"/run)
  test "$(stat -c %U "$log")" = rome
  grep -q service-output "$log"
done
echo 'PASS: service logs open as rome and cannot append through symlinks to root-owned files'
`,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
