// Rome's Slack app keeps its own copy of the direct messages it hears, and
// that copy is the connection's own business: what it exposes is reading,
// searching and sending messages, never the copy. So only the connection,
// connections/kinds/slack-app/, imports the copy's repository, and the wiring
// constructs it. Tests count, except two end-to-end tests in test/: the
// backlog test, which builds the whole graph and counts what the copy kept,
// and the opening test, which wipes the copy to show a new session reads the
// same without it.

import type { Import, ImportRule } from "../import-rules.js";

const COPY = "connections/kinds/slack-app/message-copy.ts";
const CONNECTION = "connections/kinds/slack-app/";
const WIRING = "index.ts";
const END_TO_END_TESTS = new Set([
  "test/slack-app-backlog.test.ts",
  "test/slack-app-opening.test.ts",
]);

export const slackAppCopyRules: ImportRule[] = [
  {
    name: "slack-app-copy-stays-in-the-connection",
    description:
      "The Slack app connection's copy of its messages is internal to the connection, so only files in connections/kinds/slack-app/ import its repository, and the wiring (index.ts) constructs it. Anything else reads messages through the connection.",
    rejects: (imp: Import) =>
      imp.kind === "file" &&
      imp.to === COPY &&
      !imp.from.startsWith(CONNECTION) &&
      imp.from !== WIRING &&
      !END_TO_END_TESTS.has(imp.from),
  },
];
