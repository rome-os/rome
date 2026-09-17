# Personal WeChat

The personal WeChat connection reads the guardian's account through the Linux desktop client. The [channel contracts](architecture/channels.md#wechat-personal-account) define its read-only behavior.

## Runtime requirements

- An x86-64 Linux VM running the Rome container.
- The [host helper](../packages/host-helper/README.md) installed and enabled on that VM, with its socket directory mounted into the container.
- `WECHAT_USER_ENABLED=true` and `ROME_HOST_EXECUTION_ENABLED=true` in the container environment.
- `ROME_HOST_EXECUTION_SOCKET` set to the mounted helper socket.
- `ROME_DOCKER_USER_MODE=root` so the client and the reader can access the same files under `/home/rome`.
- At least 1 GB of container shared memory (`shm_size: 1gb` in Compose).

Set `WECHAT_USER_ENABLED` to `true` to offer this connection. `false` keeps it disabled. If host execution is disabled, setup stops before downloading the client.

## Enable on a Compose deployment

The production [`docker-compose.yml`](../docker-compose.yml) reads every knob below from the `.env` file beside it, and defaults all of them to off. Add these four lines to that `.env` on a VM that runs the host helper:

```sh
WECHAT_USER_ENABLED=true
ROME_HOST_EXECUTION_ENABLED=true
ROME_DOCKER_USER_MODE=root
# Host directory holding the helper's control socket. Bound into the container
# at /run/rome-host, which is where ROME_HOST_EXECUTION_SOCKET points.
ROME_HOST_EXECUTION_SOCKET_DIR=/run/rome-host
```

Then run `docker compose up -d rome`. Compose recreates the container with the socket directory bound and the connection registered. `docker compose config` prints the resolved values.

The container mounts the socket directory whether or not the helper is installed, so a deployment that leaves these off is unchanged. Rome rejects every submission while `ROME_HOST_EXECUTION_ENABLED` is `false`.

`ROME_DOCKER_USER_MODE=root` changes the whole container, not only WeChat: every process runs as root instead of the `rome` user. Enable it on an instance whose WeChat account the guardian owns.

The older `scripts/setup.sh` writes its own Compose file, which sets no `shm_size`. The client faults during startup there. Use `docker-compose.yml` for this connection.

The Rome image includes the client libraries, debugger, and QR screenshot tools. Setup downloads WeChat 4.1.13.9 and verifies the archive checksum before extraction. The reader dependencies are pinned separately.

## Connect

1. Open Settings → Connections → WeChat.
2. Select **Connect** under **Your account**.
3. Scan the QR with WeChat on the phone and confirm the login.
4. Sync recent messages to the desktop, or send a test message to the File Transfer chat from the phone.
5. Open People and link a direct WeChat contact to a person.
6. Open that person's timeline and check the message bodies, latest message, and count.

Capture files live in a private directory under `/run` and are removed after recovery, including on failure or cancellation. Persisted reader keys have mode `0600` in a mode `0700` directory. The privileged helper matches both the container PID and its PID namespace before entering it.

Setup verifies the session database and every message shard before reporting readiness. A missing or stale shard key keeps the store locked. A readable contact list alone does not establish that message history is readable.

The client can create the message databases after key capture finishes, and it can finish writing a database after creating it. Setup keeps the captured passphrase and waits while it opens some databases but not yet every required one. A passphrase that opens none of them fails immediately. An unlocked but empty store needs messages synced from the phone before People can show history.

## Desktop recovery

Rome checks the desktop client when the connection starts and every five minutes after each check finishes. If the client stops, Rome starts it with the saved session and keys. Startup restores the client link after a container rebuild. It does not capture keys, delete the account store, or force a new login.

A readable store proves that cached history is available. It does not prove that new messages can sync. A stopped client, a failed restart, or a login window with a cached account appears as connection degradation. Cached history remains available through People and Talk history. A running login window without an account store rejects the session grant.

If WeChat shows a login window, open Rome's desktop and complete the sign-in there. Confirm on the phone if asked. Rome does not repeat key capture when the saved keys still unlock the message store.

After a restart, check both stored history and live reception:

1. Open a linked person's timeline and read an existing message.
2. Complete any desktop sign-in confirmation.
3. Send a uniquely named test message to File Transfer from the phone.
4. Check that the test message appears in the desktop store through the reader.

A running process and no visible login window are local readiness checks. Only receipt of a new message verifies live synchronization.

## Clean-login verification

Use a separate instance with a new home volume. Keep existing account stores intact. Complete one login, then check a direct conversation that contains messages.

From a source checkout inside the signed-in container, run the live contract test with the same home as the runtime:

```sh
HOME=/home/rome scripts/test-env.sh env WECHAT_USER_TEST=1 pnpm exec rstest \
  -c packages/core/rstest.config.ts \
  packages/core/src/channels/wechat-user.integration.test.ts
```

The test checks readiness, reader output, and the message store used by People. It requires development dependencies. The environment flag must be set inside the test launcher because the launcher removes runtime configuration.

If setup reports a database without a valid key, retain that diagnostic. Do not count the connection as verified or delete the store to hide the failure.
