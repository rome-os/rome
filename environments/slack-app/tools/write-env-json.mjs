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
      agent: { model, pinned_by: "model-proxy", concierge: "on" },
      fake_slack: {
        url: fakeSlack,
        control: `${fakeSlack}/_control`,
        approve_screen: `${fakeSlack}/oauth/v2/authorize`,
        app_id: e.SLACK_APP_ID,
        client_id: e.SLACK_CLIENT_ID,
        events_url: e.FAKE_SLACK_EVENTS_URL,
        retry_delays_ms: e.FAKE_SLACK_RETRY_DELAYS_MS.split(",").map(Number),
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          guardian: w.members.find((m) => m.is_owner)?.id ?? null,
          members: w.members.map((m) => m.id),
          groups: (w.channels ?? []).map((c) => c.id),
        })),
      },
      rome_cloud: {
        url: `http://127.0.0.1:${e.PANTHEON_PORT}`,
        dev_sign_in: `http://127.0.0.1:${e.PANTHEON_PORT}/api/auth/dev/start?email=`,
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
