// Merges the parts a run wrote under out/ into out/report.json and
// out/summary.md. Called by run.sh with the repo root, the verifier folder and
// the web verifier file. Exits 0 when every rule passes, else 1.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, folder, webFile] = process.argv.slice(2);
const out = join(repo, folder, "out");

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const readPart = (name) => {
  const path = join(out, `${name}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
};

// The verifier is identified by its last commit and by a hash of its files as
// they ran, since the run may use changes not yet committed.
const verifierFiles = [
  ...readdirSync(join(repo, folder))
    .filter((name) => name !== "out")
    .map((name) => join(folder, name)),
  webFile,
].sort();
const hash = createHash("sha256");
for (const file of verifierFiles) hash.update(file).update(readFileSync(join(repo, file)));
const verifierDirty = git("status", "--porcelain", "--", folder, webFile) !== "";

const core = readPart("core");
const web = readPart("web");
const proofs = readPart("proofs");
const webProof = readPart("web-proof");

const rule1 = {
  pass: Boolean(web?.pass && core?.rule1b?.pass),
  settingsTeamPage: web ?? { pass: false, steps: [], error: "the web verifier wrote no result" },
  signIn: core?.rule1b ?? { pass: false, error: "the core verifier wrote no result" },
};
const rule2Core = core?.rule2;
const rule2 = rule2Core
  ? {
      pass: rule2Core.pass,
      teammateRefused: rule2Core.operations.filter((o) => o.verdict === "teammate-refused"),
      statusDiffers: rule2Core.operations.filter((o) => o.verdict === "status-differs"),
      outsiderAdmitted: rule2Core.operations.filter((o) => o.outsider === "admitted"),
      unclaimedUpgradeHandlers: rule2Core.unclaimedUpgradeHandlers,
      mountDrift: rule2Core.mountDrift,
      exceptions: rule2Core.operations.filter((o) => o.verdict === "exception"),
      outOfScope: rule2Core.outOfScope,
      called: rule2Core.operations.filter((o) => o.verdict !== "out-of-scope").length,
      operations: rule2Core.operations,
    }
  : { pass: false, error: "the core verifier wrote no result" };

const report = {
  productCommit: git("rev-parse", "HEAD"),
  verifier: {
    lastCommit: git("log", "-1", "--format=%H", "--", folder, webFile) || null,
    uncommittedChanges: verifierDirty,
    filesSha256: hash.digest("hex"),
  },
  ranAt: new Date().toISOString(),
  elapsedMs: core?.elapsedMs ?? null,
  rules: { rule1, rule2 },
  proofs: proofs || webProof ? { rule2: proofs, settingsDriver: webProof } : null,
};
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const verdict = (pass) => (pass ? "PASS" : "FAIL");
const outcome = (o) => (o ? `${o.stage} ${o.status}` : "-");
const lines = [
  "# Team verifier: phase 1",
  "",
  `Product commit: ${report.productCommit}`,
  `Verifier: last commit ${report.verifier.lastCommit ?? "none"}${
    verifierDirty ? " plus uncommitted changes" : ""
  }, files sha256 ${report.verifier.filesSha256.slice(0, 16)}`,
  "",
  `## Rule 1: ${verdict(rule1.pass)}`,
  "",
  `Settings > Team page: ${verdict(rule1.settingsTeamPage.pass)}`,
  ...(rule1.settingsTeamPage.steps ?? []).map(
    (s) => `- ${s.ok ? "ok" : "FAILED"}: ${s.step}${s.ok ? "" : ` (${s.detail})`}`,
  ),
  "",
  `Sign-in through the Rome Cloud visitor grant: ${verdict(rule1.signIn.pass)}`,
  ...[...(rule1.signIn.invited ?? []), ...(rule1.signIn.uninvited ?? [])].map(
    (s) => `- ${s.ok ? "ok" : "FAILED"}: ${s.step}${s.ok ? "" : ` (${s.detail})`}`,
  ),
  "",
  `## Rule 2: ${verdict(rule2.pass)}`,
  "",
];
if (rule2.error) lines.push(rule2.error);
else {
  lines.push(
    `${rule2.called} operations called as the guardian and as a teammate.`,
    "",
    `Guardian admitted, teammate refused (${rule2.teammateRefused.length}):`,
    ...rule2.teammateRefused.map(
      (o) =>
        `- ${o.route}: guardian ${outcome(o.outcomes.guardian)}, teammate ${outcome(o.outcomes.teammate)}`,
    ),
    "",
    `Other status differences (${rule2.statusDiffers.length}):`,
    ...rule2.statusDiffers.map(
      (o) =>
        `- ${o.route}: guardian ${outcome(o.outcomes.guardian)}, teammate ${outcome(o.outcomes.teammate)}`,
    ),
    "",
    `A visitor not on the list admitted where a signed-out caller is refused (${rule2.outsiderAdmitted.length}):`,
    ...rule2.outsiderAdmitted.map((o) => `- ${o.route}: ${outcome(o.outcomes.outsider)}`),
    "",
    `Upgrade handlers that answer no known path: ${JSON.stringify(rule2.unclaimedUpgradeHandlers)}`,
    `Mount drift from src/index.ts: ${JSON.stringify(rule2.mountDrift)}`,
    "",
    "Exceptions applied:",
    ...rule2.exceptions.map((o) => `- ${o.route} (${o.exception})`),
    "",
    "Out of scope:",
    ...rule2.outOfScope.map((o) => `- ${o.route} (${o.reach})`),
  );
}
if (report.proofs) {
  lines.push("", "## Proofs", "", "```json", JSON.stringify(report.proofs, null, 2), "```");
}
writeFileSync(join(out, "summary.md"), `${lines.join("\n")}\n`);
process.stdout.write(
  `${lines.slice(0, 4).join("\n")}\nRule 1: ${verdict(rule1.pass)}\nRule 2: ${verdict(rule2.pass)}\nReport: ${join(out, "report.json")}\n`,
);
process.exit(rule1.pass && rule2.pass ? 0 : 1);
