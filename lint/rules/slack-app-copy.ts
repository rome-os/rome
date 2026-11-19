// Rome's Slack app keeps its own copy of the direct messages it hears, and
// that copy is the connection's own business: what it exposes is reading,
// searching and sending messages, never the copy. So only the connection,
// connections/kinds/slack-app/, imports the copy's repository, and the wiring
// constructs it. Tests count.

import type { Import, ImportRule } from "../import-rules.js";

const COPY = "connections/kinds/slack-app/message-copy.ts";
const CONNECTION = "connections/kinds/slack-app/";
const WIRING = "index.ts";

export const slackAppCopyRules: ImportRule[] = [
  {
    name: "slack-app-copy-stays-in-the-connection",
    description:
      "The Slack app connection's copy of its messages is internal to the connection, so only files in connections/kinds/slack-app/ import its repository, and the wiring (index.ts) constructs it. Anything else reads messages through the connection.",
    rejects: (imp: Import) =>
      imp.kind === "file" &&
      imp.to === COPY &&
      !imp.from.startsWith(CONNECTION) &&
      imp.from !== WIRING,
  },
];
