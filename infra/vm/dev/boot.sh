#!/usr/bin/env bash
# Boot a built host image under qemu/KVM with a NoCloud seed that injects your
# SSH key and a dev .env, then starts Rome. SSH lands on localhost:2222.
#
#   infra/vm/dev/boot.sh out/rome-host-amd64.qcow2 [--fresh] [--wechat]
#
# --wechat enables the host helper and personal WeChat at first boot, the
# per-host act that a tenant gets from apply.sh --wechat. The image must have
# been built with --hostd.
#
# The image is booted through a throwaway overlay, so the built artifact is
# never modified. --fresh discards the previous overlay.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../pins.env"
image=""
fresh=false
wechat=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fresh) fresh=true ;;
    --wechat) wechat=true ;;
    --*)
      echo "boot.sh: unknown option $1" >&2
      exit 2
      ;;
    *)
      [[ -z "$image" ]] || break
      image="$1"
      ;;
  esac
  shift
done
[[ -n "$image" ]] || {
  echo "usage: boot.sh IMAGE [--fresh] [--wechat] [-- qemu args]" >&2
  exit 2
}
[[ "${1:-}" == "--" ]] && shift
ssh_port="${ROME_VM_SSH_PORT:-2222}"
web_port="${ROME_VM_WEB_PORT:-18080}"
# qemu-system-x86_64 with KVM and OVMF: this script boots amd64 images on an
# amd64 host. An arm64 image needs qemu-system-aarch64 with AAVMF, which the
# desktop's Lima provider covers.
case "$(basename "$image")" in
  *amd64*) ;;
  *)
    echo "boot.sh: only amd64 images boot here; got $(basename "$image")" >&2
    exit 2
    ;;
esac
[[ "$(uname -m)" == x86_64 ]] || {
  echo "boot.sh: needs an x86_64 host with KVM" >&2
  exit 2
}
work="$(dirname "$image")/dev"
mkdir -p "$work"
overlay="$work/$(basename "$image" .qcow2)-dev.qcow2"
$fresh && rm -f "$overlay" "$work/OVMF_VARS.fd"
# The overlay is larger than the image; cloud-init growpart expands the root
# filesystem at first boot, as it does on a Vultr disk. Worktree image pulls
# need the headroom.
new_vm=false
if [[ ! -f "$overlay" ]]; then
  qemu-img create -q -f qcow2 -b "$(realpath "$image")" -F qcow2 "$overlay" "${ROME_VM_DISK:-40G}"
  new_vm=true
fi

if $wechat && ! $new_vm; then
  echo "boot.sh: --wechat is first-boot state and this VM already booted; enable it with: infra/vm/apply.sh --wechat dev@127.0.0.1 -- -p $ssh_port" >&2
  exit 2
fi

# The seed is first-boot state, like a tenant's. It is written with the
# overlay and reused on later boots, so the JWT secret and the instance id
# stay put and cloud-init does not run its first-boot modules again.
if $new_vm; then
  pubkey="$(cat "${ROME_VM_SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}")"
  cat >"$work/user-data" <<UD
#cloud-config
hostname: rome-host-dev
users:
  - name: dev
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: docker
    shell: /bin/bash
    ssh_authorized_keys:
      - $pubkey
write_files:
  # Dev loop: the guest pulls worktree builds from the host registry on the
  # slirp gateway over plain HTTP, the same registry scripts/vm/vm.sh pushes to.
  - path: /etc/docker/daemon.json
    content: |
      { "insecure-registries": ["10.0.2.2:${ROME_VM_REGISTRY_PORT:-5000}"] }
  - path: /opt/rome/.env
    permissions: "0600"
    content: |
      ROME_DOCKER_IMAGE=${ROME_IMAGE_REPO#docker.io/}:${ROME_IMAGE_TAG}
      ROME_JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
runcmd:
  - systemctl restart docker
  - systemctl start rome-load-image.service
  - cd /opt/rome && docker compose up -d
$($wechat && printf '  - touch /etc/rome-host/wechat && bash /etc/rome-host/provision/run.sh apply\n')
UD
  printf 'instance-id: rome-host-dev-%s\nlocal-hostname: rome-host-dev\n' "$(date +%s)" >"$work/meta-data"
  cloud-localds "$work/seed.iso" "$work/user-data" "$work/meta-data"
fi

ovmf_dir="${OVMF_DIR:-$(dirname "$(dirname "$(command -v qemu-system-x86_64)")")/share/OVMF}"
[[ -d "$ovmf_dir" ]] || ovmf_dir="${OVMF_FD:?set OVMF_DIR or OVMF_FD to the OVMF firmware dir}"
# The plain firmware, not a secure-boot build: an unsigned guest would not boot.
code="$(find "$ovmf_dir" -name 'OVMF_CODE.fd' -o -name 'OVMF_CODE_4M.fd' | head -1)"
vars_src="$(find "$ovmf_dir" -name 'OVMF_VARS.fd' -o -name 'OVMF_VARS_4M.fd' | head -1)"
[[ -f "$code" && -f "$vars_src" ]] || {
  echo "boot.sh: no OVMF_CODE.fd / OVMF_VARS.fd under $ovmf_dir" >&2
  exit 2
}
[[ -f "$work/OVMF_VARS.fd" ]] || install -m 0644 "$vars_src" "$work/OVMF_VARS.fd"

# Interactive by default: serial console and qemu monitor on this terminal.
# ROME_VM_CONSOLE_LOG=path detaches the console to a file for scripted runs.
console=(-nographic -serial mon:stdio)
[[ -n "${ROME_VM_CONSOLE_LOG:-}" ]] && console=(-display none -monitor none -serial "file:$ROME_VM_CONSOLE_LOG")
exec qemu-system-x86_64 -enable-kvm -cpu host -smp 4 -m 6G ${console[@]+"${console[@]}"} \
  -drive if=pflash,format=raw,readonly=on,file="$code" \
  -drive if=pflash,format=raw,file="$work/OVMF_VARS.fd" \
  -drive file="$overlay",if=virtio,format=qcow2 \
  -drive file="$work/seed.iso",if=virtio,format=raw,media=cdrom \
  -nic user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${ssh_port}-:22,hostfwd=tcp:127.0.0.1:${web_port}-:8080 \
  "$@"
