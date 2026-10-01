#!/bin/bash
# Host helper for personal WeChat (docs/wechat-personal.md), in two acts that
# stay separate (docs/architecture/host-execution.md):
#
#   install  whenever a rome-hostd binary is staged at /etc/rome-host/rome-hostd
#            or already installed: binary, unit, and a config with
#            "enabled": false. A build does only this.
#   enable   only when the /etc/rome-host/wechat marker exists, which apply.sh
#            --wechat or a first-boot seed sets per host: config flips to
#            enabled with a hostId derived from this machine, and the compose
#            override gives the container the socket and the WeChat flags.
#
# Writes /run/rome-host/changed when the running helper needs a restart, so
# run.sh restarts it only then and never orphans an in-flight job otherwise.
set -euo pipefail
root=/etc/rome-host
files=$root/files
. "$root/provision/lib.sh"
changed=false

if [[ -f $root/rome-hostd ]]; then
  if ! cmp -s "$root/rome-hostd" /usr/local/bin/rome-hostd; then
    # A running helper holds its binary open: install beside, then rename over.
    install -m 0755 "$root/rome-hostd" /usr/local/bin/.rome-hostd.new
    mv /usr/local/bin/.rome-hostd.new /usr/local/bin/rome-hostd
    changed=true
  fi
  rm -f "$root/rome-hostd"
fi
[[ -x /usr/local/bin/rome-hostd ]] || exit 0

if ! cmp -s "$files/rome-hostd.service" /etc/systemd/system/rome-hostd.service; then
  install -m 0644 "$files/rome-hostd.service" /etc/systemd/system/rome-hostd.service
  changed=true
fi
mkdir -p /var/lib/rome-host && chmod 700 /var/lib/rome-host

# Identity comes from the machine, never from the image. A sealed image has an
# empty machine-id, so a build writes a placeholder the helper accepts but no
# job can name; the first apply on a host replaces it.
enabled=false
host_id=unprovisioned
if [[ -s /etc/machine-id ]]; then
  host_id="$(cut -c1-12 /etc/machine-id)"
  [[ -e $root/wechat ]] && enabled=true
fi
config="$(mktemp)"
printf '{"hostId":"%s","enabled":%s,"socketPath":"/run/rome-host/control.sock","stateDir":"/var/lib/rome-host","socketGid":0,"maxTimeoutSeconds":600,"maxOutputBytes":131072}\n' \
  "$host_id" "$enabled" >"$config"
if ! cmp -s "$config" "$root/config.json"; then
  install -m 0644 "$config" "$root/config.json"
  changed=true
fi
rm -f "$config"

# The override is the host layer's enabling switch and is owned here, unlike
# the compose file beside it. It is written on enable and removed on disable.
if $enabled; then
  install_if_changed "$files/docker-compose.override.wechat.yml" /opt/rome/docker-compose.override.yml
  systemctl enable rome-hostd.service >/dev/null 2>&1
elif [[ ! -e $root/wechat ]]; then
  # Disabled on this host: the helper neither runs nor starts at boot.
  if [[ -f /opt/rome/docker-compose.override.yml ]]; then
    rm -f /opt/rome/docker-compose.override.yml
    mark_changed docker-compose.override.yml
  fi
  systemctl disable --now rome-hostd.service >/dev/null 2>&1 || true
fi
$changed && mark_changed rome-hostd
true
