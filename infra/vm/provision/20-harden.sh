#!/bin/bash
# Host hardening: sshd fail2ban jail and the container egress block for the
# cloud metadata endpoint. Same rules as Rome Cloud's cloud-init.
set -euo pipefail
files=/etc/rome-host/files
. /etc/rome-host/provision/lib.sh
if ! dpkg -s fail2ban >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y --no-install-recommends fail2ban
  apt-get clean
  rm -rf /var/lib/apt/lists/*
fi
install -d /etc/systemd/system/docker.service.d
install_if_changed "$files/docker-rome-block-metadata.conf" /etc/systemd/system/docker.service.d/rome-block-metadata.conf
install_if_changed "$files/rome-sshd.local" /etc/fail2ban/jail.d/rome-sshd.local
install_if_changed "$files/rome-block-metadata.service" /etc/systemd/system/rome-block-metadata.service
# Validate the jail offline; a broken jail fails the run, not the boot.
fail2ban-client -t >/dev/null
systemctl enable fail2ban rome-block-metadata.service >/dev/null 2>&1
