// Prints env.json: the commits, the agent model, and every address and
// control endpoint the verifier needs. Called by up.sh; reads no secret.
//
// Usage: node write-env-json.mjs <env-sha> <rome-sha> <rome-ref> <rome-cloud-sha> <rome-cloud-ref> <model> <state-dir>

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [envSha, romeSha, romeRef, cloudSha, cloudRef, model, stateDir] = process.argv.slice(2);
const envDir = dirname(dirname(fileURLToPath(import.meta.url)));
const e = process.env;
const ctl = join(envDir, "ctl.sh");
const workspaces = JSON.parse(
  readFileSync(join(envDir, "config/workspaces.json"), "utf8"),
).workspaces;
const home = process.env.FAKE_SLACK_HOME_TEAM || workspaces[0].id;
const enroll = (name) => {
  try {
    return JSON.parse(readFileSync(join(stateDir, `${name}-enroll.json`), "utf8"));
  } catch {
    return null;
  }
};
const instance = (name, port, guardian) => ({
  name,
  url: `http://127.0.0.1:${port}`,
  guardian_email: guardian,
  // The guardian's signed-in session on the instance, as a cookie map.
  guardian_cookies_file: join(stateDir, `${name}-cookies.json`),
  enroll: enroll(name),
  stop: [ctl, "stop", name],
  start: [ctl, "start", name],
  status: [ctl, "status", name],
  control: {
    stop: [ctl, "stop", name],
    start: [ctl, "start", name],
    status: [ctl, "status", name],
    // Append a Slack conversation id. Stops the instance, wipes Rome's copy of
    // that chat, starts it again; exit 0 when no copy is left.
    wipe_chat: [ctl, "wipe-chat", name],
  },
});

const fakeSlack = `http://127.0.0.1:${e.FAKE_SLACK_PORT}`;
console.log(
  JSON.stringify(
    {
      version: 1,
      created_at: new Date().toISOString(),
      commits: {
        environment: envSha,
        rome: romeSha,
        rome_ref: romeRef,
        rome_cloud: cloudSha,
        rome_cloud_ref: cloudRef,
      },
      // The checkouts this run uses, at the commits above. rome has its
      // dependencies installed, so its import rules run there.
      repos: {
        rome: join(stateDir, "rome-src"),
        rome_cloud: join(stateDir, "rome-cloud-src"),
        rome_cloud_base_ref: e.ROME_CLOUD_BASE_REF ?? "origin/main",
        rome_dependencies: e.ROME_DEPENDENCIES ?? "not_installed",
      },
      agent: { model, pinned_by: "model-proxy", concierge: "on" },
      fake_slack: {
        url: fakeSlack,
        control: `${fakeSlack}/_control`,
        approve_screen: `${fakeSlack}/oauth/v2/authorize`,
        app_id: e.SLACK_APP_ID,
        client_id: e.SLACK_CLIENT_ID,
        events_url: e.FAKE_SLACK_EVENTS_URL,
        retry_delays_ms: e.FAKE_SLACK_RETRY_DELAYS_MS.split(",").map(Number),
        // Slack's limit on conversations.history and .replies for an app
        // outside the Marketplace; POST control/config {history_limit} changes it.
        history_limit: { on: true, requests_per_minute: 1, max_messages: 15 },
        // The app's public distribution (R2): on, any workspace can approve
        // it; off, only its home workspace. ctl.sh distribution on|off sets it,
        // and control/approvals records each answer with its workspace.
        distribution: { on: true, home_team: home, switch: [ctl, "distribution"] },
        workspaces: workspaces.map((w, i) => ({
          id: w.id,
          name: w.name,
          home: w.id === home,
          // The first two are the guardians' own (rome-a and rome-b sign in
          // there); the rest belong to nobody on the team and no instance.
          owned_by_team: i < 2,
          guardian: w.members.find((m) => m.is_owner)?.id ?? null,
          members: w.members.map((m) => m.id),
          // Each member's direct message with the bot, as the fake names it.
          im_channels: Object.fromEntries(
            w.members.map((m) => [
              m.id,
              `D${w.id.replace(/^T/, "").slice(0, 4)}${m.id.replace(/^U/, "")}`,
            ]),
          ),
          groups: (w.channels ?? []).map((c) => c.id),
        })),
      },
      rome_cloud: {
        url: `http://127.0.0.1:${e.PANTHEON_PORT}`,
        dev_sign_in: `http://127.0.0.1:${e.PANTHEON_PORT}/api/auth/dev/start?email=`,
        // SQL on stdin, a JSON array of rows on stdout, read only.
        query: [ctl, "cloud-query"],
      },
      relay: { url_inside_network: "http://relay:8787" },
      instances: [
        instance("rome-a", e.ROME_A_PORT, "guardian-a@slackenv.test"),
        instance("rome-b", e.ROME_B_PORT, "guardian-b@slackenv.test"),
      ],
      // A stop of an instance stands in for the 1 hour outage in R6.
      shortened: { r6_stop_minutes: 2 },
      differences: join(envDir, "DIFFERENCES.md"),
      down: [join(envDir, "down.sh")],
    },
    null,
    2,
  ),
);
