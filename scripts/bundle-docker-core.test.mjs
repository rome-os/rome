import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundledAssets, dockerBundleOptions } from "./bundle-docker-core.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx/package.json"))("esbuild");

for (const dockerfile of ["Dockerfile", "infra/rome/Dockerfile"]) {
  test(`${dockerfile} leaves OpenCLI on its browser extension transport`, async () => {
    const source = await readFile(join(root, dockerfile), "utf8");
    assert.doesNotMatch(source, /^ENV OPENCLI_CDP_ENDPOINT=/m);
  });
}

for (const endpoint of [undefined, "http://chrome:9333"]) {
  test(`shell startup does not inject a browser endpoint (${endpoint ?? "unset"})`, () => {
    const output = execFileSync(
      "bash",
      [
        "--noprofile",
        "--norc",
        "-c",
        'source "$1"; if alias opencli >/dev/null 2>&1; then exit 1; fi; exec "$2" -e "process.stdout.write(process.env.OPENCLI_CDP_ENDPOINT ?? String())"',
        "opencli-env-test",
        join(root, "scripts/docker/rome-shell-aliases.sh"),
        process.execPath,
      ],
      {
        env: {
          PATH: process.env.PATH,
          ...(endpoint === undefined ? {} : { OPENCLI_CDP_ENDPOINT: endpoint }),
        },
        encoding: "utf8",
      },
    );
    assert.equal(output, endpoint ?? "");
  });
}

test("the relocated Caddy generator runs without Core workspace dependencies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rome-compiled-caddy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "caddy.cjs");
  await build({
    ...dockerBundleOptions("cjs"),
    entryPoints: [join(root, "packages/core/src/lib/caddyfile-generator.ts")],
    outfile,
    logLevel: "silent",
  });

  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `const { generateCaddyfile } = require(${JSON.stringify(outfile)});
       console.log(generateCaddyfile({
         enableAccessControl: true,
         allowedApps: ["@alice/calendar"],
         cloudEmailAccess: {},
       }));`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.ok(output.includes("/apps/%40alice%2Fcalendar"));
});

test("compiled People contracts run in plain Node without TypeScript source resolution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rome-compiled-people-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "people.mjs");
  await build({
    ...dockerBundleOptions(),
    stdin: {
      contents: 'export { timelinePageLimit } from "@rome/api-types/people";',
      resolveDir: join(root, "packages/core"),
      sourcefile: "people-entry.ts",
      loader: "ts",
    },
    outfile,
    logLevel: "silent",
  });

  const output = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { timelinePageLimit } from "./people.mjs";
       console.log(timelinePageLimit("75"));`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(Number(output), 75);
});

// The compiled runtime reads these next to its own module, so a missing copy is
// only visible in the image — the source tree keeps working under tsx.
test("bundles the WeChat scripts the compiled runtime reads from dist", async () => {
  const expected = [
    ["packages/core/src/channels/wechat-user-helper.py", "dist/wechat-user-helper.py"],
    [
      "packages/core/src/channels/wechat-user-launch-driver.py",
      "dist/wechat-user-launch-driver.py",
    ],
    ["packages/core/src/channels/vendor/wcdb_key_tool.py", "dist/vendor/wcdb_key_tool.py"],
  ];

  for (const [source, destination] of expected) {
    const entry = bundledAssets.find(([, dest]) => dest === destination);
    assert.ok(entry, `no bundled asset copied to ${destination}`);
    assert.equal(entry[0], source);
    await readFile(join(root, source), "utf8");
  }
});
