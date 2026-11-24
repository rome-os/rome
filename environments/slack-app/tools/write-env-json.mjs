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
// The copy this file describes (tools/copy.sh). The default copy's commands
// stay as they were; another names itself to ctl.sh and down.sh.
const project = e.SLACKENV_PROJECT || "slackenv";
const named = project === "slackenv" ? [] : ["--project", project];
const ctl = join(envDir, "ctl.sh");
const ctlCmd = (...args) => [ctl, ...named, ...args];
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
const readState = (file) => {
  try {
    return JSON.parse(readFileSync(join(stateDir, file), "utf8"));
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
  stop: ctlCmd("stop", name),
  start: ctlCmd("start", name),
  status: ctlCmd("status", name),
  control: {
    stop: ctlCmd("stop", name),
    start: ctlCmd("start", name),
    status: ctlCmd("status", name),
    // Connects Rome's Slack app as the guardian in its own workspace (Acme for
    // rome-a, Bayside for rome-b); prints {instance, outcome, connection_id},
    // outcome "connected" or "already", exit 0 once connected.
    connect: ctlCmd("connect", name),
    // Append a Slack conversation id. Stops the instance, wipes Rome's copy of
    // that chat, starts it again; exit 0 when no copy is left.
    wipe_chat: ctlCmd("wipe-chat", name),
    // Whether /run/rome/slack-oauth-token exists in the instance, and the last
    // 6 characters of the bot and user tokens it holds.
    token_file: ctlCmd("token-file", name),
    // R10: writes the older slack_bot and slack connections into the stopped
    // instance and starts it again. Prints old_connections below, whose checks
    // report what the instance made of the rows without judging them; exit 0
    // once the rows are written and the instance is healthy.
    // up.sh --old-connections <name> runs it before this file.
    old_connections: ctlCmd("old-connections", name),
    // R10, read only: whether the rows old_connections wrote are still stored,
    // {slack_bot: {connection_id, stored}, slack: {connection_id, stored}};
    // stored when both the connections row and its connection_grants row are.
    old_rows: ctlCmd("old-rows", name),
    // The instance's log; append --since <RFC 3339 time> for a time span, and
    // --tail <lines>|all. Without either, the last 500 lines.
    logs: ctlCmd("logs", name),
  },
  old_connections_file: join(stateDir, `${name}-old-connections.json`),
  // What old_connections printed last, or null before it ran: per kind its
  // connection_id, account_id, app_id, bot_user_id and checks.
  old_connections: readState(`${name}-old-connections.json`),
  // The instance's own listing of recent action executions (name, status),
  // newest first; the guardian's cookies sign it. ?actionName=&limit=
  action_executions: `http://127.0.0.1:${port}/api/action-executions`,
});

const fakeSlack = `http://127.0.0.1:${e.FAKE_SLACK_PORT}`;
console.log(
  JSON.stringify(
    {
      version: 1,
      created_at: new Date().toISOString(),
      // Which copy this is: its compose project, host port base and state
      // folder (this file is in it). ctl.sh and down.sh take it as --project.
      copy: { project, port_base: Number(e.SLACKENV_PORT_BASE ?? 47100), state_dir: stateDir },
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
      // The model proxy sends every request to `model` and keeps the effort
      // Rome asks for: the Concierge's agent file asks low. stats counts
      // requests by the model Rome asked for and by model and effort sent;
      // usage (or ctl.sh usage --since --until) the tokens and cost of the
      // message turns in a span.
      agent: {
        model,
        effort: "low",
        effort_set_by: "rome",
        pinned_by: "model-proxy",
        concierge: "on",
        model_proxy: {
          stats: `http://127.0.0.1:${e.MODEL_PROXY_HOST_PORT}/_stats`,
          usage: `http://127.0.0.1:${e.MODEL_PROXY_HOST_PORT}/_usage`,
          usage_command: ctlCmd("usage"),
        },
      },
      // Rome Cloud's slack-gateway Worker, when the rome-cloud commit has it
      // (wrangler.slack.jsonc); null otherwise. Inside the network it is
      // https://slack.romeos.io, and the fake Slack sends its events there.
      // probe runs its checks as rome-a's or rome-b's instance; secrets are the
      // environment's own test values, in .state/secrets.env.
      slack_gateway:
        e.SLACK_GATEWAY === "on"
          ? {
              url: `http://127.0.0.1:${e.SLACK_GATEWAY_PORT}`,
              network_url: "https://slack.romeos.io",
              health: "https://slack.romeos.io/health",
              rome_cloud_url: e.CLOUD_ORIGIN,
              relay_origin: "https://relay.slackenv.test",
              slack_origin: "https://slack.com",
              logs: ctlCmd("logs", "slack-gateway"),
              probe: ctlCmd("gateway-probe"),
            }
          : null,
      fake_slack: {
        url: fakeSlack,
        control: `${fakeSlack}/_control`,
        approve_screen: `${fakeSlack}/oauth/v2/authorize`,
        // Several mentions, direct messages and group messages at one moment
        // (POST {items}), and what the app posted (GET ?team&channel&thread_ts&since).
        batch: `${fakeSlack}/_control/batch`,
        posts: `${fakeSlack}/_control/posts`,
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
        distribution: { on: true, home_team: home, switch: ctlCmd("distribution") },
        workspaces: workspaces.map((w, i) => ({
          id: w.id,
          name: w.name,
          home: w.id === home,
          // The first two are the guardians' own (rome-a and rome-b sign in
          // there); the rest belong to nobody on the team and no instance.
          owned_by_team: i < 2,
          guardian: w.members.find((m) => m.is_owner)?.id ?? null,
          members: w.members.map((m) => m.id),
          // Full members other than the guardian, and guests (is_restricted
          // on users.info); any of them can send the bot a direct message.
          full_members: w.members
            .filter((m) => !m.is_owner && !m.is_restricted && !m.is_ultra_restricted)
            .map((m) => m.id),
          guests: w.members
            .filter((m) => m.is_restricted || m.is_ultra_restricted)
            .map((m) => m.id),
          // Each member's direct message with the bot, as the fake names it.
          im_channels: Object.fromEntries(
            w.members.map((m) => [
              m.id,
              `D${w.id.replace(/^T/, "").slice(0, 4)}${m.id.replace(/^U/, "")}`,
            ]),
          ),
          groups: (w.channels ?? []).map((c) => c.id),
          // The shared groups the bot is in, each with its members.
          groups_with_bot: (w.channels ?? [])
            .filter((c) => c.bot_member !== false)
            .map((c) => ({
              id: c.id,
              name: c.name,
              members: c.members ?? w.members.map((m) => m.id),
            })),
          // Groups the bot is not in, and what was said in each group before
          // the app arrived.
          groups_without_bot: (w.channels ?? [])
            .filter((c) => c.bot_member === false)
            .map((c) => c.id),
          seeded_messages: (w.channels ?? []).flatMap((c) =>
            (c.seed_messages ?? []).map((m) => ({
              channel: c.id,
              bot_member: c.bot_member !== false,
              ts: m.ts,
              user: m.user,
              text: m.text,
              ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
            })),
          ),
        })),
      },
      rome_cloud: {
        // https with the slack-gateway Worker, under the environment's own
        // certificate: trust_pem for Node, and ignoreHTTPSErrors (or the CA)
        // in a browser context.
        url: e.CLOUD_ORIGIN,
        dev_sign_in: `${e.CLOUD_ORIGIN}/api/auth/dev/start?email=`,
        trust_pem: join(stateDir, "trust.pem"),
        // SQL on stdin, a JSON array of rows on stdout, read only.
        query: ctlCmd("cloud-query"),
      },
      relay: { url_inside_network: "http://relay:8787" },
      // Test files of the rome commit under test, run unchanged in an image of
      // that commit with every dependency (built on first use per commit).
      // Append repo-relative paths. Prints the runner's output, then a last
      // line {ok, commit, runs: [{package, files, exit_code}], error?}; exits
      // 0 when all pass, 2 when a file is not in the commit, 126 when the test
      // image lacks a file.
      // A test file that is not in the commit (the verifier's own) runs the
      // same way with --add <host file>=<repo-relative path>, placed read-only
      // where the commit has nothing, under a package whose rstest config
      // takes it.
      product_tests: ctlCmd("product-tests"),
      product_tests_add_flag: "--add",
      // A Playwright browser in a container on the host's network, so the
      // instances' own origins work. Connect with the client below:
      // (await import(browser.import)).chromium.connect(browser.ws_endpoint).
      browser: {
        ws_endpoint: `ws://127.0.0.1:${e.BROWSER_PORT}/`,
        version: e.SLACKENV_PLAYWRIGHT_VERSION,
        client: join(stateDir, "browser-client"),
        import: join(stateDir, "browser-client/node_modules/playwright-core/index.mjs"),
      },
      // R10. The older connections, as an upgrade leaves them, and how each
      // sends. Routes are the instance's, signed with the guardian's cookies.
      old_connections: {
        slack_bot: {
          // Rome hears the bot over Socket Mode. POST this with
          // {app_id, event: {type: "message", channel_type: "im", channel:
          // <the member's im_channels entry>, user, text, ts}} and the
          // Concierge answers through chat.postMessage with the bot's token;
          // control/posts?team= shows it with the bot's appId.
          hear: `${fakeSlack}/_control/socket-event`,
          sockets: `${fakeSlack}/_control/sockets`,
          // A new one: setup of the placeholder's bot grant.
          connect_route: "POST /api/connections/slack_bot/grants/bot/setup",
        },
        slack: {
          // Rome Cloud's earlier OAuth app. Nothing in core sends through
          // it; the connector's connector_proxy action (toolkit slack) reads
          // its tokens from the token file, so a Concierge turn that posts
          // through the connector sends with them.
          token_file: "control.token_file of the instance",
          connect_route: "GET or POST /api/oauth/slack/start",
        },
        // The Connect picker: placeholders are the entries with id null.
        picker_route: "GET /api/connections",
        restart: "control.stop then control.start of the instance; its data stays",
      },
      instances: [
        instance("rome-a", e.ROME_A_PORT, "guardian-a@slackenv.test"),
        instance("rome-b", e.ROME_B_PORT, "guardian-b@slackenv.test"),
      ],
      // A stop of an instance stands in for the 1 hour outage in R6.
      shortened: { r6_stop_minutes: 2 },
      differences: join(envDir, "DIFFERENCES.md"),
      down: [join(envDir, "down.sh"), ...named],
    },
    null,
    2,
  ),
);
