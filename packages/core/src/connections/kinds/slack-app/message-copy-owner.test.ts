// Only the Slack app connection touches its copy's table. The import rule
// slack-app-copy-stays-in-the-connection keeps the repository in the
// connection; this keeps the table itself there.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const CONNECTION = "connections/kinds/slack-app/";
// The schema declares the table, the end-to-end backlog test counts what the
// copy kept, and the end-to-end opening test wipes it.
const OTHERS = new Set([
  "db/schema/system.ts",
  "test/slack-app-backlog.test.ts",
  "test/slack-app-opening.test.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("the Slack app's copy of its messages", () => {
  it("is read and written only in the connection", () => {
    const touching = sources(SRC)
      .filter((path) =>
        /\bslackAppMessages\b|\bslack_app_messages\b/.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(SRC, path).split("\\").join("/"))
      .filter((path) => !path.startsWith(CONNECTION) && !OTHERS.has(path));
    expect(touching).toEqual([]);
  });
});
