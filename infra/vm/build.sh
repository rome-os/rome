#!/usr/bin/env bash
# Build the Rome host image: a stock Ubuntu cloud image plus Docker, hardening,
# and the Rome runtime image preloaded. Runs offline against the disk file via
# libguestfs; no VM boots during the build.
#
#   infra/vm/build.sh [--arch amd64|arm64] [--out DIR] [--base-only] [--hostd PATH]
#
# --hostd installs the host helper binary and unit, disabled. Enabling it on a
# host is a separate act: apply.sh --wechat, or a first-boot seed that sets the
# marker (docs/architecture/host-execution.md). Build the binary for the
# target arch with: CGO_ENABLED=0 GOOS=linux GOARCH=<arch> go build -o
# rome-hostd ./cmd/rome-hostd from packages/host-helper.
#
# Needs on PATH: virt-customize virt-resize qemu-img skopeo curl sha256sum.
# The appliance runs the host's architecture, so build arm64 on an arm64 host.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
. "$here/pins.env"

arch="$(dpkg --print-architecture 2>/dev/null || uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
out="${ROME_VM_OUT:-$PWD/out}"
base_only=false
hostd=""
disk_size="${ROME_VM_DISK_SIZE:-20G}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)
      arch="$2"
      shift 2
      ;;
    --out)
      out="$2"
      shift 2
      ;;
    --base-only)
      base_only=true
      shift
      ;;
    --hostd)
      hostd="$2"
      shift 2
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 2
      ;;
  esac
done
mkdir -p "$out"
host_arch="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
[[ "$arch" == "$host_arch" ]] || {
  echo "build.sh: --arch $arch needs a $arch host; this one is $host_arch (the libguestfs appliance runs the host's architecture)" >&2
  exit 2
}

# 1. Pinned base image. The dated release URL never changes content.
base_name="ubuntu-${UBUNTU_VERSION}-server-cloudimg-${arch}.img"
base_url="https://cloud-images.ubuntu.com/releases/${UBUNTU_RELEASE}/release-${UBUNTU_SERIAL}/${base_name}"
base_sha_var="UBUNTU_SHA256_${arch}"
base_sha="${!base_sha_var:?no pinned sha256 for $arch}"
base="$out/base-${arch}-${UBUNTU_SERIAL}.img"
if [[ ! -f "$base" ]]; then
  curl -fsSL --retry 5 -o "$base.part" "$base_url"
  mv "$base.part" "$base"
fi
echo "$base_sha  $base" | sha256sum -c - || {
  rm -f "$base"
  exit 1
}

# 2. Grow the root filesystem offline so the preloaded image fits. The cloud
#    image ships a 3.5G disk; virt-resize writes a new file with sda1 expanded.
grown="$out/base-${arch}-${UBUNTU_SERIAL}-${disk_size}.qcow2"
if [[ ! -f "$grown" ]]; then
  qemu-img create -f qcow2 "$grown.part" "$disk_size"
  virt-resize --expand /dev/sda1 "$base" "$grown.part"
  mv "$grown.part" "$grown"
fi
$base_only && {
  echo "$grown"
  exit 0
}

# 3. Rome image by digest, one platform, no daemon. The digest pin is the
#    integrity check, so the signature policy accepts anything. docker-archive is what
#    `docker load` consumes on first boot.
rome_tar="$out/rome-${arch}-${ROME_IMAGE_DIGEST#sha256:}.tar"
if [[ ! -s "$rome_tar" ]]; then
  # The tag is the human name for the digest; refuse a pins.env where the
  # two have drifted apart.
  tag_digest="sha256:$(skopeo inspect --policy "$here/files/skopeo-policy.json" --raw "docker://${ROME_IMAGE_REPO}:${ROME_IMAGE_TAG}" | sha256sum | cut -d' ' -f1)"
  [[ "$tag_digest" == "$ROME_IMAGE_DIGEST" ]] || {
    echo "build.sh: ${ROME_IMAGE_REPO}:${ROME_IMAGE_TAG} resolves to $tag_digest, pins.env says $ROME_IMAGE_DIGEST" >&2
    exit 1
  }
  skopeo copy --policy "$here/files/skopeo-policy.json" --override-arch "$arch" --override-os linux \
    "docker://${ROME_IMAGE_REPO}@${ROME_IMAGE_DIGEST}" \
    "docker-archive:$rome_tar.part:${ROME_IMAGE_REPO#docker.io/}:${ROME_IMAGE_TAG}"
  mv "$rome_tar.part" "$rome_tar"
fi

# 4. Customize a copy. The whole tree goes to /etc/rome-host and run.sh does
#    the rest inside the guest, the same way apply.sh does on a live host.
#    `--run` would hand scripts to the guest's /bin/sh (dash), so run.sh is
#    invoked through bash explicitly.
image="$out/rome-host-${arch}.qcow2"
cp --reflink=auto "$grown" "$image.part"
# Staged under $out, next to the tar, so the multi-GB copy is a reflink or
# at least stays off a small tmpfs.
stage="$out/.stage"
rm -rf "$stage"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/rome-host"
cp -r "$here/pins.env" "$here/provision" "$here/files" "$stage/rome-host/"
cp --reflink=auto "$rome_tar" "$stage/rome-host/rome.tar"
if [[ -n "$hostd" ]]; then
  # An ELF for the target arch: e_machine 0x3e is x86-64, 0xb7 is aarch64.
  magic="$(od -An -tx1 -N4 "$hostd" 2>/dev/null | tr -d ' ' || true)"
  machine="$(od -An -tx1 -j18 -N1 "$hostd" 2>/dev/null | tr -d ' ' || true)"
  case "$arch:$magic:$machine" in
    amd64:7f454c46:3e | arm64:7f454c46:b7) ;;
    *)
      echo "build.sh: $hostd is not a linux/$arch ELF binary" >&2
      exit 1
      ;;
  esac
  cp "$hostd" "$stage/rome-host/rome-hostd"
fi
export LIBGUESTFS_MEMSIZE="${LIBGUESTFS_MEMSIZE:-2048}"
virt-customize -a "$image.part" --smp 4 \
  --copy-in "$stage/rome-host:/etc" \
  --run-command "bash /etc/rome-host/provision/run.sh build"
mv "$image.part" "$image"
sha256sum "$image" >"$image.sha256"
echo "$image"
