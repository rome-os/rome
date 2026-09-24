# Devbox rerun evidence (2026-09-24, UTC)

This run used the `devbox` device from Settings → Devices, in worktree
`~/workspace/wda-proto-replay` on branch `prototype/webchat-default-agent-replay`.
It started with `ROME_DEV_SKIP_TOKEN_SEED=1 FEATURE_GATE_ROME_CLOUD_AUTH=off
pnpm dev:all` at the time in `devall-started-at`. The compose project was
`prototype-webchat-default-agent-replay`.

- Identity checks before and after the run: `idcheck-1.txt` and
  `idcheck-2-after.txt`, produced by `idcheck.sh`. `identity-log-lines.log`
  holds the cloud-auth, enrollment, and relay lines from each boot.
- Server decisions: `server-wda-proto.log` holds the catalog events, boot
  reconciles, saves, clears, session creations, and loader failures.
- Scenario traces:
  - `s1.log`: Scenario 1.
  - `s2.log`: Scenario 2.
  - `s3-restart.log`, `s3-reload.log`, `s3-window*.log`: Scenario 3.
  - `s45.log`: Scenarios 4 and 5.
  - `s46.log`: Advanced after reinstall, the boot reconcile, and Scenario 6.
  - `sdrop.log`: an upgrade that drops the agent.
- The drivers ran inside the dev container through `dev-all.sh`. The helper
  scripts here were run on the devbox. `restart.sh` restarts the rome
  container and its Chrome sidecar.
- Model turns failed with "No model provider is available". The fresh dev
  instance has no provider signed in, so turn execution was not observed in
  this run.
