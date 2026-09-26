import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { preparePagesSite } from "./prepare-pages-site.mjs";

const shard = async (root, label) => {
  const directory = path.join(root, "midscene-shard-1", "midscene_run", "report", label);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "index.html"), label);
};

test("keeps historical root links and publishes recent runs at stable paths", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rome-pages-site-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous");
  const legacy = path.join(root, "legacy");
  const reports = path.join(root, "reports");
  const site = path.join(root, "site");
  await shard(previous, "recent-old");
  await shard(legacy, "affected-old");
  await shard(reports, "new");
  await mkdir(path.join(previous, "midscene-shard-1/midscene_run/report/screenshots"));
  await mkdir(path.join(legacy, "midscene-shard-1/midscene_run/report/screenshots"));
  await writeFile(path.join(previous, "midscene-shard-1/midscene_run/report/screenshots/recent.jpeg"), "recent");
  await writeFile(path.join(legacy, "midscene-shard-1/midscene_run/report/screenshots/affected.jpeg"), "affected");
  await writeFile(path.join(legacy, "index.html"), "affected summary");
  await writeFile(path.join(reports, "index.html"), "new summary");
  await mkdir(path.join(previous, "runs", "100"), { recursive: true });
  await writeFile(path.join(previous, "runs", "100", "index.html"), "older run");

  const first = await preparePagesSite({ site, reports, runId: "101", previous, previousRunId: "100", legacy, legacyRunId: "99" });
  assert.deepEqual(first.runIds, ["100", "101"]);
  assert.match(await readFile(path.join(site, "index.html"), "utf8"), /index-99\.html/);
  assert.equal(await readFile(path.join(site, "index-99.html"), "utf8"), "affected summary");
  assert.equal(
    await readFile(path.join(site, "midscene-shard-1/midscene_run/report/affected-old/index.html"), "utf8"),
    "affected-old",
  );
  assert.equal(
    await readFile(path.join(site, "midscene-shard-1/midscene_run/report/recent-old/index.html"), "utf8"),
    "recent-old",
  );
  assert.equal(
    await readFile(path.join(site, "midscene-shard-1/midscene_run/report/screenshots/affected.jpeg"), "utf8"),
    "affected",
  );
  assert.equal(await readFile(path.join(site, "runs/101/index.html"), "utf8"), "new summary");

  const next = path.join(root, "next");
  await preparePagesSite({ site: next, reports, runId: "102", previous: site });
  const final = path.join(root, "final");
  const result = await preparePagesSite({ site: final, reports, runId: "103", previous: next });
  assert.deepEqual(result.runIds, ["101", "102", "103"]);
  await assert.rejects(stat(path.join(final, "runs", "100")), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(final, "midscene-shard-1/midscene_run/report/affected-old/index.html"), "utf8"),
    "affected-old",
  );
});

test("rejects nonnumeric run IDs", async () => {
  await assert.rejects(preparePagesSite({ site: "unused", runId: "../escape" }), /numeric/);
});

test("rejects conflicting historical screenshot IDs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rome-pages-conflict-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous");
  const legacy = path.join(root, "legacy");
  const reports = path.join(root, "reports");
  await shard(previous, "old");
  await shard(legacy, "older");
  await mkdir(path.join(previous, "midscene-shard-1/midscene_run/report/screenshots"));
  await mkdir(path.join(legacy, "midscene-shard-1/midscene_run/report/screenshots"));
  await writeFile(path.join(previous, "midscene-shard-1/midscene_run/report/screenshots/same.jpeg"), "first");
  await writeFile(path.join(legacy, "midscene-shard-1/midscene_run/report/screenshots/same.jpeg"), "second");
  await mkdir(reports);
  await writeFile(path.join(reports, "index.html"), "summary");
  await assert.rejects(
    preparePagesSite({ site: path.join(root, "site"), reports, runId: "101", previous, legacy }),
    /Conflicting report asset/,
  );
});

test("prunes older run directories before exceeding the Pages budget", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rome-pages-budget-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const previous = path.join(root, "previous");
  const reports = path.join(root, "reports");
  await mkdir(path.join(previous, "runs", "100"), { recursive: true });
  await writeFile(path.join(previous, "runs", "100", "report.bin"), Buffer.alloc(12_000));
  await shard(reports, "new");
  await writeFile(path.join(reports, "index.html"), "summary");
  await writeFile(
    path.join(reports, "midscene-shard-1/midscene_run/report/new/report.bin"),
    Buffer.alloc(12_000),
  );

  const site = path.join(root, "site");
  const result = await preparePagesSite({ site, reports, runId: "101", previous, maxSiteBytes: 20_000 });
  assert.deepEqual(result.runIds, ["101"]);
  assert.ok(result.bytes < 20_000);
  await assert.rejects(stat(path.join(site, "runs", "100")), { code: "ENOENT" });
  assert.doesNotMatch(await readFile(path.join(site, "index.html"), "utf8"), /Run 100/);
});
