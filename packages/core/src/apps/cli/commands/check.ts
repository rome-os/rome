import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Args, Command, Flags } from "@oclif/core";
import { readApp } from "../../capability-check/read-app.js";
import { renderReport } from "../../capability-check/report.js";
import { checkApp } from "../../capability-check/rules.js";
import { resolveFromInvokerCwd } from "../lib.js";

export default class Check extends Command {
  static override description =
    "Check apps against the capability rules: agents can discover what each app can do, and " +
    "every capability has an interface for agents and one for people. Prints a gap report and " +
    "exits non-zero when any rule has a gap. Reads source only; runs nothing from the app.";

  static override examples = [
    "pnpm --filter @rome/core app:check",
    "pnpm --filter @rome/core app:check rome_apps/inbox",
    "pnpm --filter @rome/core app:check ./my-app --json",
  ];

  static override strict = false;

  static override args = {
    apps: Args.string({
      description:
        "App directories, each containing app.yaml. Defaults to every app under rome_apps/.",
    }),
  };

  static override flags = {
    json: Flags.boolean({ description: "Print the verdicts as JSON instead of Markdown." }),
  };

  async run(): Promise<void> {
    const { argv, flags } = await this.parse(Check);
    const dirs =
      (argv as string[]).length > 0
        ? (argv as string[]).map((dir) => resolveFromInvokerCwd(dir))
        : firstPartyApps();
    const verdicts = [];
    for (const dir of dirs) verdicts.push(checkApp(await readApp(dir)));
    this.log(flags.json ? JSON.stringify(verdicts, null, 2) : renderReport(verdicts));
    if (verdicts.some((verdict) => verdict.gaps.length > 0)) this.exit(1);
  }
}

function firstPartyApps(): string[] {
  const root = resolveFromInvokerCwd("rome_apps");
  const base = existsSync(root) ? root : join(process.cwd(), "../../rome_apps");
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "app.yaml")))
    .map((entry) => join(base, entry.name))
    .sort();
}
