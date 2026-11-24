# Slack app rubric, live

Scores three rubric entries for the official Slack app against real Slack and production (the Worker at slack.romeos.io, Rome Cloud at romeos.cc, and the tester's own Rome):

1. **approval-page**: Rome's "Add Slack" link arrives at Slack's approval page. The link comes from Rome Cloud's `POST /api/instance/slack/install-url`, never built here, and is opened in Chromium signed in as the tester.
2. **direct-message**: a direct message to the Rome bot gets a reply within 60 s.
3. **mention**: a message mentioning the bot, in a channel the bot and the tester share, gets a reply in the channel or a thread within 60 s.

Each entry scores `pass`, `fail`, or `not checked` with the reason. Entries 2 and 3 are `not checked: app not installed` when no workspace user has `profile.api_app_id` A0BEGBH132L (or the app given with `--app-id`). Entry 1 is `not checked` without a signer JWT from an instance enrolled with Rome Cloud, since install-url answers nothing else.

## Run

```bash
nix develop -c node verifiers/slack-app-live/run.mjs \
  --env ~/.config/rome/slack-tester.env --out ~/slackenv-runs/live-1 \
  --chromium "$(command -v chromium)" [--signer-jwt-file <path>]
```

The env file holds `SLACK_TESTER_USER_TOKEN`, `SLACK_TESTER_TEAM_ID`, `SLACK_TESTER_USER_ID` and `SLACK_TESTER_D_COOKIE`. The script never prints or writes their values. Reports hold ts values, status codes, timings and page titles only.

The tester is a real person whose messages reach their real Rome, so a run sends at most one message per entry, each starting with `[rubric check]` and a nonce.

## Test

```bash
node --test verifiers/slack-app-live/entries.test.mjs
```

The tests score every entry against a stub Slack with a moved clock.
