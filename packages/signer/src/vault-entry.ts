import { runVault } from "./vault-cli.js";

process.exitCode = await runVault(process.argv.slice(2), process.env, {
  out: (bytes) => process.stdout.write(bytes),
  err: (bytes) => process.stderr.write(bytes),
});
