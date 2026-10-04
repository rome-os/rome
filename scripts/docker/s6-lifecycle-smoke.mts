#!/usr/bin/env node
// Runs the s6 setup and finish scripts at their supervisor boundaries.
// Usage: node scripts/docker/s6-lifecycle-smoke.mts <image>
// The image needs Node 24, s6, execline, and tsx installed under /app.
// Build one with this Dockerfile:
//   FROM node:24
//   RUN apt-get update && apt-get install -y --no-install-recommends s6 execline
//   RUN npm install --prefix /app tsx

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
`,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
