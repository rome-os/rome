# Rome host layer

`infra/vm` defines the host a Rome container runs on: Ubuntu with Docker
Engine at a pinned version, fail2ban, the metadata-endpoint block, the compose
project under `/opt/rome`, and optionally the host helper for personal WeChat.
The Rome image itself is not part of this layer. It is preloaded into new
images as a first-boot accelerator and upgraded in place by Rome Cloud's
existing upgrade flow.

One definition, three runners:

| Runner | Runs the steps | For |
| --- | --- | --- |
| `build.sh` | inside a disk file via `virt-customize`, no VM boots | the image new machines start from |
| `apply.sh` | over SSH on a live host | bringing existing machines up to this tree |
| `dev/boot.sh` | boots a built image under KVM with a dev seed | a local VM shaped like a Vultr tenant |

The steps are the scripts in `provision/`, run in order by `provision/run.sh`.
They read `pins.env` and `files/` from `/etc/rome-host` on the target, where
every runner places this tree. Each step is idempotent, so applying to a host
built from the same tree changes nothing, and the tree stays on the host as
provenance.

## Layout

- `pins.env` pins every input: host layer version, Ubuntu release serial and
  sha256, Docker apt versions, Rome image digest.
- `provision/10-docker.sh` installs Docker at the pin and holds it.
- `provision/20-harden.sh` installs fail2ban with its jail, and the metadata
  block with a docker.service drop-in that reasserts it on every Docker start.
- `provision/30-rome.sh` seeds the compose file when `/opt/rome` has none, and
  places the first-boot load unit. A tenant's Rome Cloud bundle is never
  overwritten.
- `provision/40-wechat.sh` installs `rome-hostd` disabled whenever a binary is
  staged, and enables it with the WeChat compose override only on a host
  carrying the `/etc/rome-host/wechat` marker. Installing and enabling stay
  two acts, as [host execution](../../docs/architecture/host-execution.md)
  requires, and the helper's `hostId` comes from the machine, not the image.
- `provision/90-seal.sh` strips machine identity. Build only.
- `provision/run.sh build|apply` runs the steps, then seals (build) or
  reloads systemd and restarts the affected units (apply). Writes
  `/etc/rome-host/applied` with the version.
- `files/` holds the units, jail, compose files, and helper config the steps
  install.
- `dev/boot.sh` boots a built image locally.

## Build an image

```sh
infra/vm/build.sh --arch amd64 --out out
infra/vm/build.sh --arch amd64 --out out --hostd packages/host-helper/dist/rome-hostd
qemu-img convert -O raw out/rome-host-amd64.qcow2 out/rome-host-amd64.raw   # Vultr
```

The build downloads and verifies the base image, grows its root partition
offline with `virt-resize`, fetches one platform of the Rome image by digest
with `skopeo` into a `docker-archive` tar, copies the tree plus the tar into
the disk, and runs `run.sh build` inside. The libguestfs appliance runs the
host's architecture, so an arm64 image is built on an arm64 host.

## Upgrade a live host

```sh
infra/vm/apply.sh root@tenant-host -- -p 22
infra/vm/apply.sh --hostd packages/host-helper/dist/rome-hostd root@tenant-host   # install, disabled
infra/vm/apply.sh --wechat root@tenant-host                                       # enable on this host
```

A host-layer change is an edit to `provision/` or `files/` plus a bump of
`HOST_LAYER_VERSION`. The bump is a human act; the version says what a host
was told to be, and the step scripts converge it regardless. Moving the
Docker pin on a live host reinstalls the engine and restarts every
container, so schedule such an apply like a Rome upgrade. New machines get it through a rebuilt image; existing
machines through `apply.sh`, which Rome Cloud can call over the SSH channel
its upgrade script already uses. The tree on the host is replaced whole, so
a file removed from the tree is removed there too. `--wechat` persists on the
host, so a later plain apply keeps WeChat enabled; `--no-wechat` turns it
off. The helper restarts only when its binary, unit, or config changed, so a
routine apply never interrupts a running root job.

## Run a VM locally

```sh
infra/vm/dev/boot.sh out/rome-host-amd64.qcow2            # SSH :2222, Rome :18080
infra/vm/dev/boot.sh out/rome-host-amd64.qcow2 --fresh    # discard the overlay
infra/vm/dev/boot.sh out/rome-host-amd64.qcow2 --wechat   # enable the helper at first boot
```

The image boots exactly as on Vultr: untouched, with a NoCloud seed doing
first-boot configuration. The seed is the only place dev and production
differ. Dev injects your SSH key, a dev user, a random JWT secret, and trust
for the host image registry on the slirp gateway. Rome Cloud's seed writes
the instance token, Pantheon origin, ClickStack credentials, and its own SSH
key instead. The VM boots from a 40G overlay (`ROME_VM_DISK`) that cloud-init
grows into, so worktree image pulls fit. Ports come from `ROME_VM_SSH_PORT`
and `ROME_VM_WEB_PORT`.

Changing Rome code needs no new host image. Push a worktree build to a
registry the guest trusts (`docker push 127.0.0.1:5000/rome:dev` on the host,
`docker pull 10.0.2.2:5000/rome:dev` in the guest), point `ROME_DOCKER_IMAGE`
in the guest's `.env` at it, and `docker compose up -d`. Changing the host
layer means `apply.sh` against the running VM, which is also the rehearsal for
applying it to tenants.

## Known boundaries

- The metadata block lives in `DOCKER-USER`, so it covers bridge-network
  egress only, IPv4 and the common IPv6 metadata address. Same scope as the
  cloud-init it replaces.
- `rome-hostd` is built from this repository by the caller and is not
  checksum-pinned; its provenance is the build that produced it.
- `dev/boot.sh` boots amd64 images on an x86_64 host only.

## Debugging an image without booting

- `virt-cat -a out/rome-host-amd64.qcow2 /etc/rome-host/applied`
- `virt-ls -l -a out/rome-host-amd64.qcow2 /opt/rome`
- `guestfish --rw -a out/rome-host-amd64.qcow2 -i` for a shell over the disk
- an overlay for one-step iteration:

```sh
qemu-img create -f qcow2 -b "$PWD/out/rome-host-amd64.qcow2" -F qcow2 out/iter.qcow2
virt-customize -a out/iter.qcow2 --run-command 'bash /etc/rome-host/provision/20-harden.sh'
```

## Tools

All from nixpkgs: `guestfs-tools` (`virt-customize`, `virt-resize`,
`virt-cat`, `virt-ls`), `libguestfs` (`guestfish`), `skopeo`, `qemu`
(`qemu-img`, `qemu-system-x86_64`), `OVMF`, `cloud-utils` (`cloud-localds`).
The `--wechat` path also needs `go` to build `rome-hostd`.
