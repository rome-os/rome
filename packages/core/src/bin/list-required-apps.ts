// Prints the app ids boot asserts are among the packed first-party artifacts,
// one per line. Boot installs every packed first-party app; this set is what
// it checks, not what it installs. Reads YAML files only, so no daemon needs
// to run.
import { deriveCoreRequiredApps } from "../apps/core-required.js";
import { getProjectRoot } from "../paths.js";
import { ALWAYS_REQUIRED_APPS } from "../wiring/required-apps.js";

const ids = await deriveCoreRequiredApps({
  projectRoot: getProjectRoot(),
  alwaysRequired: ALWAYS_REQUIRED_APPS,
});
for (const id of ids) console.log(id);
