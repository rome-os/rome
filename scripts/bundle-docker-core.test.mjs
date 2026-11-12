import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bundledAssets,
  cliCommandFiles,
  cliCommandsBundleOptions,
  dockerBundleOptions,
  splitBundleOptions,
} from "./bundle-docker-core.mjs";

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

test("the daemon bundle loads the OpenTelemetry SDK only from its telemetry chunk", async (t) => {
  const outdir = await mkdtemp(join(tmpdir(), "rome-compiled-daemon-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await build({
    ...splitBundleOptions(join(root, "packages/core/src/instance/daemon/index.ts"), outdir),
    logLevel: "silent",
  });

  const entry = await readFile(join(outdir, "index.js"), "utf8");
  assert.doesNotMatch(entry, /^import .* from "@opentelemetry\/sdk-node";$/m);
  assert.match(entry, /import\("\.\/chunks\/telemetry-[A-Z0-9]+\.js"\)/);
});

test("the action worker bundle installs telemetry before it loads the runtime", async (t) => {
  const outdir = await mkdtemp(join(tmpdir(), "rome-compiled-worker-"));
  t.after(() => rm(outdir, { recursive: true, force: true }));
  await build({
    ...splitBundleOptions(
      join(root, "packages/core/src/app-host/worker-bootstrap.ts"),
      outdir,
      "worker-bootstrap",
    ),
    logLevel: "silent",
  });

  const entry = await readFile(join(outdir, "worker-bootstrap.js"), "utf8");
  assert.match(entry, /initTelemetry\(\);\s*await import\("\.\/chunks\/worker-[A-Z0-9]+\.js"\)/);
  assert.doesNotMatch(entry, /from "pg"/);
});

test("the main bundle loads no chat channel SDK at startup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rome-compiled-main-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = join(directory, "index.js");
  await build({
    ...dockerBundleOptions("esm"),
    entryPoints: [join(root, "packages/core/src/index.ts")],
    outfile,
    logLevel: "silent",
  });

  const bundle = await readFile(outfile, "utf8");
  for (const sdk of [
    "jsdom",
    "turndown",
    "discord.js",
    "telegram",
    "@larksuiteoapi/node-sdk",
    "@whiskeysockets/baileys",
  ]) {
    const specifier = sdk.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    // A static import ends its line with `from "<sdk>";`, on one line or after a
    // multi-line specifier list. Subpaths such as telegram/events count too.
    assert.doesNotMatch(
      bundle,
      new RegExp(`^(import .* |\\} )from "${specifier}(/[^"]*)?";$`, "m"),
    );
  }
});

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
       console.log(generateCaddyfile());`,
    ],
    { cwd: directory, encoding: "utf8" },
  );
  assert.ok(output.includes("forward_auth"));
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
    [
      "packages/core/src/connections/kinds/wechat-user/wechat-user-send-driver.py",
      "dist/wechat-user-send-driver.py",
    ],
  ];

  for (const [source, destination] of expected) {
    const entry = bundledAssets.find(([, dest]) => dest === destination);
    assert.ok(entry, `no bundled asset copied to ${destination}`);
    assert.equal(entry[0], source);
    await readFile(join(root, source), "utf8");
  }
});

test("the app CLI runs every command from the bundle when src/ is absent", async (t) => {
  const core = join(root, "packages/core");
  const pkg = await mkdtemp(join(tmpdir(), "rome-compiled-cli-"));
  t.after(() => rm(pkg, { recursive: true, force: true }));
  await cp(join(core, "bin"), join(pkg, "bin"), { recursive: true });
  await cp(join(core, "package.json"), join(pkg, "package.json"));
  await symlink(join(core, "node_modules"), join(pkg, "node_modules"));
  const srcDir = join(core, "src/apps/cli/commands");
  await build({
    ...(await cliCommandsBundleOptions(srcDir, join(pkg, "dist/apps/cli/commands"))),
    logLevel: "silent",
  });

  for (const file of await cliCommandFiles(srcDir)) {
    const command = relative(srcDir, file).replace(/\.ts$/, "").split("/").join(":");
    const help = execFileSync(process.execPath, [join(pkg, "bin/apps-cli.js"), command, "--help"], {
      encoding: "utf8",
    });
    assert.match(help, /USAGE/, `${command} --help`);
  }
});
