#!/bin/bash
# Build only. Strips per-machine identity so every VM cloned from the image
# generates its own. Never run on a live host.
set -euo pipefail
truncate -s0 /etc/machine-id
rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*
# Every clone would otherwise credit the same bytes to its entropy pool.
rm -f /var/lib/systemd/random-seed
# The build's machine-id must not name the helper's host either.
if [[ -f /etc/rome-host/config.json ]]; then
  sed -i 's/"hostId":"[^"]*"/"hostId":"unprovisioned"/' /etc/rome-host/config.json
fi
rm -rf /var/lib/dhcp/* /run/rome-host
# A failed clean leaves the build's instance state baked in, and the seed on
# first boot is then ignored. That fails the build, not the boot.
cloud-init clean --logs
