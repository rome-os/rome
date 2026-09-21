# Hosted Tailnet upgrade spike

This spike copies `/var/lib/tailscale` from a stopped Rome container into a named Docker volume. The replacement and rollback containers mount the same volume. The copy treats the directory as opaque data.

## Try it

Run the focused harness without Docker:

```sh
./scripts/prototypes/hosted-tailnet-upgrade/test.sh
```

Run the container lifecycle demo on a machine with Docker Compose:

```sh
./scripts/prototypes/hosted-tailnet-upgrade/demo.sh
```

The demo uses fake state bytes. It does not use a Tailscale key, account, or real state file. It creates unique Compose projects and removes them when it exits.

## Hosted code boundary

The hosted Compose and upgrade code live in `amantru/rome-cloud`, not this repository. This spike inspected hosted commit `7c03aa922910f21569a6b08ad3928fc9322a1433` on 2026-09-21.

`packages/pantheon/deployment/docker-compose.yml` has no `/var/lib/tailscale` mount. `packages/pantheon/src/lib/providers/upgrade-script.ts` stops Rome and runs `docker compose up` on the new image. The old writable container layer does not survive that replacement.

The hosted upgrade does not refresh `/opt/rome/docker-compose.yml`. Editing the packaged Compose file alone protects new instances but misses the first fixed upgrade for existing instances.

## Production seam shown by the spike

The production change belongs in `rome-cloud`. It can use this order in the generated upgrade procedure:

1. Resolve the current Rome container and image as the upgrade does now.
2. Stop Rome and finish the database backup.
3. Stream the stopped container's complete `/var/lib/tailscale` directory into a new named volume.
4. Atomically replace the base Compose file with a packaged definition that mounts the volume with `volume.nocopy: true`.
5. Recreate Rome on the new image.
6. Use the same Compose definition and volume for rollback to `OLD_IMAGE`.

The old container still exists after `docker compose stop`, so step 3 can use `docker container cp`. Docker supports archive streaming from a stopped container. The helper mount uses `volume-nocopy` so image files cannot seed an empty volume.

The hosted host-helper feature may own `docker-compose.override.yml`. An operator may also own that file. The production change should refresh the packaged base Compose file instead of overwriting an override.

## What this proves

- The copy keeps unknown nested files and binary bytes without parsing Tailscale state.
- A replacement and an old-image rollback can mount the same state volume.
- An empty source directory produces an empty volume. The procedure does not create a device identity.
- A completion marker outside the volume makes a completed first migration safe to retry.
- Later upgrades detect that the current container already mounts the target volume and leave it in place.

## Limits

- This is a feasibility artifact, not a patch to the hosted control plane.
- The checked environment has no Docker daemon. `test.sh` ran here with a focused Docker command model. The real Docker Compose demo is supplied but was not run here.
- The spike does not decide whether `tailscaled.state` is valid. Production should preserve the directory without parsing it, then let `tailscaled` report connected, expired, or revoked state.
- A host crash after volume creation but before the completion marker can leave an unmarked volume. The prototype refuses that volume for safe manual inspection. Production needs a tested recovery rule for this window.
- The prototype does not prove the same Tailscale node ID, IP, HTTPS Serve state, or exit-node settings. Production acceptance still needs a connected hosted instance and the Tailscale control plane.
- The migration marker records only a container ID and volume name. It contains no Tailscale data or credentials.
