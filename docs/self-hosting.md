# Self-hosting Rome

## Overview

Rome runs as two containers from one image, `yunfanye/rome`. The `rome` container is the product. The `signer` container holds the instance's signing key in its own volume, has no network, and shares only a unix socket with Rome.

Rome needs the signer to use Rome Cloud: inference credits, mail, the Store, agents, and reaching your devices. Without a Rome Cloud origin, Rome runs but does not need the signer.

To run Rome on your own machine, use one of the paths below.

| Path | Use it to |
|---|---|
| [Quickstart](#quickstart) | Run the published image with one command |
| [Docker Compose](#docker-compose) | Run the published image or your own checkout from `docker-compose.yml` |
| [Development environment](#development-environment) | Work on Rome's source |

## Requirements

- Docker Engine or Docker Desktop that runs `linux/amd64` or `linux/arm64` images.
- Docker Compose v2 (`docker compose`) for the Compose path.
- About 1.8 GB of image download, plus room for your data volumes.
- A host that allows `/dev/fuse`, the `SYS_ADMIN` capability, and an unconfined AppArmor profile. Both the quickstart and `docker-compose.yml` request them.
- Free host ports: 7663 for the quickstart, 80 for the stock Compose file.

## Quickstart

One script checks for Docker, pulls `yunfanye/rome:latest`, and starts Rome.

```bash
curl -fsSL https://raw.githubusercontent.com/rome-os/rome/main/scripts/quickstart-docker.sh | bash
```

To run it from a clone instead:

```bash
git clone https://github.com/rome-os/rome.git
cd rome
./scripts/quickstart-docker.sh
```

The script starts two containers, `rome` and `rome-signer`, and these named volumes:

| Volume | Holds |
|---|---|
| `rome-app`, `rome-user-home`, `rome-rome-home`, `rome-ssh-host-keys` | Rome's code, data, and SSH host keys |
| `rome-signer-key` | The signer's private key |
| `rome-signer-sock` | The socket Rome uses to reach the signer |

It also saves a web-login secret in `~/.rome/quickstart/jwt-secret`, so logins survive a container replacement. When Rome has started, the script prints the dashboard URL, which is `http://localhost:7663`. The port is bound to loopback only.

Pass options to the script after `--`:

```bash
curl -fsSL https://raw.githubusercontent.com/rome-os/rome/main/scripts/quickstart-docker.sh | bash -s -- --port 8080
```

| Option | Effect |
|---|---|
| `--port PORT` | Host port for the dashboard (default 7663) |
| `--name NAME` | Container name, also the prefix of the signer container and all volumes (default `rome`) |
| `--bind ADDR` | Host address the ports bind to (default `127.0.0.1`) |
| `--image TAG` | Image to run (default `yunfanye/rome:latest`) |
| `--env-file PATH` | Extra env file passed to the Rome container |
| `--no-pull` | Run the local image without pulling |

Run `./scripts/quickstart-docker.sh --help` for the environment overrides and the optional Rome settings, such as `ANTHROPIC_API_KEY`.

## Docker Compose

Use the repository's `docker-compose.yml` to keep the configuration in files. It defines `rome`, `signer`, and an optional `otel-collector`.

### Set up

1. Clone the repository and enter it.

   ```bash
   git clone https://github.com/rome-os/rome.git
   cd rome
   ```

2. Create `.env`. Compose requires the file, and without `ROME_JWT_SECRET` Rome signs web logins with a built-in default secret.

   ```bash
   echo "ROME_JWT_SECRET=$(openssl rand -hex 32)" > .env
   echo "ROME_LOOPBACK_CALLBACK_ORIGIN=http://localhost:7663" >> .env
   ```

   The second line is the address the browser returns to after you connect to Rome Cloud. It must match the host port in step 4.

3. Create an empty `.env.collector`. Compose requires this file too, even when you do not run the collector.

   ```bash
   touch .env.collector
   ```

4. Create `docker-compose.override.yml`. The stock file publishes the dashboard on host port 80 on every network interface. This override keeps it on loopback at port 7663 and needs Compose 2.24 or newer. Git ignores this file.

   ```yaml
   services:
     rome:
       ports: !override
         - "127.0.0.1:7663:8080"
   ```

Add `ANTHROPIC_API_KEY=...` to `.env` if you have one. Without it, onboarding offers Claude-account login.

### Start with the published image

The published image is built in compiled mode. The Compose file defaults to source mode, so set the code mode to match the image. Source mode on the published image fails because the image has no TypeScript sources.

```bash
echo "ROME_DOCKER_APP_CODE_MODE=compiled" >> .env
docker compose pull rome
docker compose up -d --no-build rome
```

### Start from your checkout

Build the image first. The service has both `build:` and `image:`, so building first makes `signer` use your build instead of pulling the published image.

```bash
docker compose build rome
docker compose up -d rome
```

The default code mode is `source`, which is correct for a local build. The build compiles the whole workspace and takes a while.

### What it starts

Either way, `up -d rome` starts `rome` and, through `depends_on`, `signer`. The project name is `rome`, so the containers are `rome-rome-1` and `rome-signer-1`, and the volumes are `rome_app`, `rome_user-home`, `rome_rome-home`, `rome_signer-key`, and `rome_signer-sock`.

The dashboard is at `http://localhost:7663`.

### Host paths and devices

| Path | Used for |
|---|---|
| `.env`, `.env.collector` | Read from the checkout directory |
| `~/docker/ssh-host-keys` | SSH host keys. Docker creates the directory as root if it is missing |
| `/run/rome-host` | Control socket directory for the optional host helper. Change it with `ROME_HOST_EXECUTION_SOCKET_DIR` if Docker cannot bind that path on your host |
| `./infra/observability/otel-collector-config.yaml` | Collector configuration, mounted read-only |
| `/dev/fuse` | Device passed to the `rome` container |

### The telemetry collector

`otel-collector` forwards Rome's telemetry to a ClickHouse instance that you run. Rome does not depend on it and boots without it, so the commands above skip it.

To use it, put `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USERNAME`, and `CLICKHOUSE_PASSWORD` in `.env.collector`. Add `CLICKHOUSE_DATABASE` to change the database name from `default`. Then run `docker compose up -d`. See `.env.collector.example`.

### The older installer

`scripts/setup.sh` is an older installer that writes its own Compose file in `~/rome` and asks for Docker Hub credentials. Prefer the quickstart or the repository's Compose file. If you ran it before, re-running it regenerates that Compose file with the signer service and keeps the existing `.env`.

## Development environment

To run Rome from source with live reload, you need Node.js 24, Corepack with pnpm 11.6, and Docker with Compose.

```bash
corepack enable
pnpm install
pnpm dev:all
```

The script prints the local URLs and the development login when startup completes. The stack connects to `https://romeos.cc` by default. Set `ROME_DEV_PANTHEON_ORIGIN` to use another Rome Cloud.

The signer is on by default. `ROME_DEV_SIGNER=0 pnpm dev:all` leaves it out and uses the legacy instance token. See [DEVELOPMENT.md](../DEVELOPMENT.md) for the full loop.

## Connecting to Rome Cloud

Rome Docker images default to `PANTHEON_BASE_ORIGIN=https://romeos.cc`. To use another Rome Cloud, set `PANTHEON_BASE_ORIGIN` to its origin:

- Quickstart: set it in your shell, for example `PANTHEON_BASE_ORIGIN=https://cloud.example.com ./scripts/quickstart-docker.sh`. With `curl | bash`, put the assignment before `bash`.
- Compose: add it to `.env`, then run `docker compose up -d rome`.

The signer issues tokens for one Rome Cloud origin, and that origin follows `PANTHEON_BASE_ORIGIN`. Recreating the containers applies a change. If you export `PANTHEON_BASE_ORIGIN` as empty, the quickstart turns Rome Cloud off and starts no signer.

To link the instance, sign in or connect to Rome Cloud from the dashboard. Rome registers the signer's key with Rome Cloud as part of that step, and no other setup is needed.

## First run and exposure

Onboarding is open to whoever reaches the dashboard first, and that visitor becomes the guardian. Keep the loopback bind until onboarding is done.

To expose Rome after that:

- Quickstart: re-run the script with `--bind 0.0.0.0`, or with one interface address. The script warns when the address is not loopback.
- Compose: change the address in `docker-compose.override.yml`, for example `"0.0.0.0:7663:8080"`, then run `docker compose up -d rome`.

The container serves plain HTTP. Put a TLS reverse proxy in front of it before you expose it beyond a network you trust.

## Updating

Data lives in named volumes, so updates keep it. Do not delete the `signer-key` volume. A new signer key makes Rome Cloud ask you to sign in again.

- Quickstart: re-run the script. It pulls the newest image and replaces both containers.
- Compose, published image: `git pull`, then `docker compose pull rome`, then `docker compose up -d --no-build rome`.
- Compose, your checkout: `git pull`, then `docker compose build rome`, then `docker compose up -d rome`.
- Development: `git pull`, then `pnpm dev:all`.

## Checking that it works

1. Confirm both containers are running. The quickstart names them `rome` and `rome-signer`.

   ```bash
   docker ps --filter name=rome
   docker compose ps   # Compose only
   ```

2. Open the dashboard, or check the health endpoint. Use your port, 7663 in these examples.

   ```bash
   curl -fsS http://localhost:7663/api/health
   ```

   A healthy Rome answers `{"status":"ok"}`.

3. Check the link to Rome Cloud. This endpoint needs no login.

   ```bash
   curl -fsS http://localhost:7663/api/instance/enroll/status
   ```

   `enrolled` is `true` once the instance is linked. `issue` is `null` unless the signer or the link has a problem. In that case it holds a `state` and a `message`, which the next section lists.

## Troubleshooting

Signer problems appear as the `issue` message from `/api/instance/enroll/status` and as `instance identity needs attention` lines in the Rome log. Read the signer's own log with `docker logs rome-signer`, or `docker compose logs signer` under Compose.

**Signing service is not running.** Rome cannot reach the signer. Check that the signer container is running, then restart it. Rome retries every 30 seconds.

**The signing service is configured for a different Rome Cloud address.** The signer's origin differs from Rome's `PANTHEON_BASE_ORIGIN`. Recreate both containers so they read the same value: re-run the quickstart script, or run `docker compose up -d rome`. Rome registers and unlinks nothing while the addresses differ.

**System clock is off.** The host clock differs from real time by more than two minutes. Synchronize the clock. Rome retries every 30 seconds.

**This instance's credential was registered elsewhere. Sign in again.** Rome Cloud holds a different signer key for this instance, usually because the `signer-key` volume was recreated. Connect to Rome Cloud again from the dashboard.

**Update your compose file to add the signer service.** An older install runs without the signer. Pull the current `docker-compose.yml` and run `docker compose up -d rome`, or re-run the quickstart script.

**Port is already allocated, or address already in use.** Another program uses the host port. Pick another one: `--port` for the quickstart, or the port in `docker-compose.override.yml`.

**Compose reports a missing env file.** Create `.env` and `.env.collector` as described in [Set up](#set-up).

**The `rome` container exits at startup under Compose, and the log mentions `generate-caddyfile.ts`.** The published image is running in source mode. Set `ROME_DOCKER_APP_CODE_MODE=compiled` in `.env` and run `docker compose up -d --no-build rome`.

## Removing Rome

Removing volumes deletes Rome's data and the signer key.

- Quickstart:

  ```bash
  docker rm -f rome rome-signer
  docker volume rm rome-app rome-user-home rome-rome-home rome-ssh-host-keys rome-signer-key rome-signer-sock
  rm -rf ~/.rome/quickstart
  ```

  Replace `rome` with your `--name` if you set one.

- Compose: `docker compose down` removes the containers and keeps the data. `docker compose down -v` also removes the volumes. Delete `~/docker/ssh-host-keys` if you want the host keys gone.
- Development:

  ```bash
  docker compose -f compose.dev.yml -p "$(scripts/worktree-slug.sh)" --profile signer down -v
  ```

  [DEVELOPMENT.md](../DEVELOPMENT.md#per-worktree-state) also covers the per-worktree state directory.
