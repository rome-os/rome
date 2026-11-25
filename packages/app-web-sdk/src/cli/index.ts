import { runBuild } from "./build.js";
import { runDev } from "./dev.js";
import { CliError } from "./store/config.js";
import { runLogin } from "./store/login.js";
import { runWhoami } from "./store/whoami.js";
import { runPublish } from "./store/publish.js";
import { runUpgrade } from "./upgrade.js";

const HELP = `rome — Rome app CLI

Develop:
  rome dev        Start the dev server with HMR
  rome build      Build the app web bundle for production
  rome upgrade    Bump app.yaml version by major, minor, or patch

Dev and build read app.yaml (web.displayName, web.navLabel, web.entry)
and emit dist/ with manifest.json + assets/. An app.yaml with no web
section builds without a web bundle; dev requires one.

Rome App Store:
  rome login      Log in to the Rome App Store and store credentials
  rome whoami     Show the currently logged-in account
  rome publish    Package a Rome app directory and upload it

Run "rome <command> --help" for command options.
`;

// Commands that take their own flags/positionals and parse argv themselves.
const ARG_COMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  login: runLogin,
  whoami: runWhoami,
  publish: runPublish,
  upgrade: runUpgrade,
};

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(HELP);
    return;
  }

  const argHandler = ARG_COMMANDS[command];
  if (argHandler) {
    await argHandler(rest);
    return;
  }

  if (rest.length > 0) {
    process.stderr.write(`rome: unexpected argument(s): ${rest.join(" ")}\n`);
    process.exit(2);
  }

  switch (command) {
    case "dev":
      await runDev();
      return;
    case "build":
      await runBuild();
      return;
    default:
      process.stderr.write(`rome: unknown command "${command}"\n${HELP}`);
      process.exit(2);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(err.exitCode);
  }
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
