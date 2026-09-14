# Rome host helper

`rome-hostd` runs on a dedicated Linux host and accepts root script jobs from
Rome through a Unix socket. It has no TCP listener or third-party runtime
dependencies. The [host execution contracts](../../docs/architecture/host-execution.md)
define its trust boundary and job lifetime.

The helper is optional. Both its host policy and
`ROME_HOST_EXECUTION_ENABLED=true` in Rome must permit new submissions.
Inspection and cancellation remain available when submission is disabled.
Socket access grants the trusted container authority over the host. Root can
read host credentials and change host services, including the helper itself.

## Build and verify

From this directory in the Nix development shell on Linux:

```sh
go test -race ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux go build -o dist/rome-hostd ./cmd/rome-hostd
```

On macOS, use the container integration check below. It runs a root helper and a nonroot client in separate
isolated Linux containers. It mounts only a test socket volume between them.
It never mounts the Docker daemon socket or the real host root filesystem.
From the repository root:

```sh
bash scripts/host-helper/smoke.sh
```

## Host configuration

The CLI accepts `--config`, which defaults to `/etc/rome-host/config.json`.
The config file and its directory must be protected from unprivileged writers.
The CLI requires Linux root. Example configuration:

```json
{
  "hostId": "my-vm",
  "enabled": false,
  "socketPath": "/run/rome-host/control.sock",
  "stateDir": "/var/lib/rome-host",
  "socketGid": 10001,
  "maxTimeoutSeconds": 600,
  "maxOutputBytes": 131072
}
```

Choose `socketGid` from the actual Rome backend user's primary group in the
runtime image. The sample value is not an image default. Mount the socket
directory into the Rome container and set `ROME_HOST_EXECUTION_SOCKET` to
the socket's container path. Keep the source directory stable during service
restarts and create it before Docker restores containers on VM boot.

Rome Cloud manages the binary, systemd unit, socket mount, and instance policy
through its deployment bundle. The helper release and the Rome image can
upgrade independently. The host must contain only credentials whose authority
the operator intends to delegate to its root scripts.

## Job protocol

| Request | Result |
| --- | --- |
| `GET /v1/capabilities` | Protocol version, host identity, policy, interpreters, and limits |
| `POST /v1/jobs` | Durable acceptance, or the existing identical job |
| `GET /v1/jobs/<id>` | Job state and bounded output |
| `POST /v1/jobs/<id>/cancel` | Idempotent cancellation of the managed job |

Rome submits through `system:execute_root_script` and manages the returned ID
through `system:manage_root_script`. A job ID is the SHA256 of the submitting
Rome execution ID. A new action execution creates a new job. When a response is
lost, inspect the known job before starting another execution.

The helper runs `/bin/sh -s` or `/bin/bash -s` with the script on stdin. Its
working directory is private to the job, and it receives a minimal environment.
Container paths and environment variables are not inherited. A successful
submission can report a job that is still running. Terminal failures in Rome
include the job snapshot as JSON in the action's error string.

One job runs at a time. At most 10,000 job identities are retained. At capacity,
new submissions fail while inspection and cancellation continue. The helper
never evicts an accepted identity or recursively removes work directories.
Operators must monitor disk use and archive work with awareness of files and
mounts a root script can create. Do not delete job records to recover capacity:
doing so discards deduplication history. Replace the host identity and retire
the old target when provisioning a fresh job store.

A job supervisor kills and reaps ordinary process-group descendants when the
helper dies. Recovery waits for that cleanup before accepting jobs. An interrupted
nonterminal job becomes `unknown`, and the helper never restarts its script. Root scripts can escape ordinary process
cleanup or create persistent services, so cancellation is not rollback.

## Releases

The Host helper workflow runs Go tests and the container integration check.
After the source is merged, run the workflow on `main` with a bare semver, or
push a `host-helper-v<version>` tag that points to a merged commit.

Each release contains `rome-hostd-linux-amd64`, `rome-hostd-linux-arm64`, and
`SHA256SUMS`. `rome-hostd --version` prints the embedded version. Configure
Rome Cloud with the exact artifact URL, digest, and version. A mutable image
tag or a GitHub repository credential is not required on the VM.
