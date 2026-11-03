// Starts the channel scenario UI against this repository's core scenarios.
// Usage: pnpm channels:ui [--port 3212] [--watch] [--run]
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "./server.js";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3212" },
    // Rerun every scenario when a file under packages/core/src changes.
    watch: { type: "boolean", default: false },
    // Run every scenario once on start.
    run: { type: "boolean", default: false },
  },
});

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const traces = `${repo}.channel-traces`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ui = serve({
  traces,
  web: fileURLToPath(new URL("../dist/web/", import.meta.url)),
  port: Number(values.port),
  ...(values.watch ? { watch: `${repo}packages/core/src` } : {}),
  command: ({ names }) => ({
    command: "pnpm",
    args: [
      "--filter",
      "@rome/core",
      "exec",
      "../../scripts/test-env.sh",
      "env",
      `ROME_CHANNEL_TRACES=${traces}`,
      "rstest",
      "src/test/kit/im",
      ...(names?.length ? ["-t", `^(${names.map(escape).join("|")})$`] : []),
    ],
    cwd: repo,
  }),
});

ui.server.on("listening", () => {
  console.log(`Channel scenarios: http://127.0.0.1:${values.port}`);
  if (values.run) ui.run({});
});
