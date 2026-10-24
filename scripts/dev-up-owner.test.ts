import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { OWNER_FILE } from "./gc-stack-guard.js";

// dev-up.sh needs Docker to run, so this reads its order instead. The owner
// file must be written only once the stack is accepted and up: a start refused
// by the collision check must leave the previous owner in place, or gc will
// later tear down another checkout's stack.
const devUp = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dev-up.sh"), "utf8");

describe("dev-up.sh owner file", () => {
  const writes = devUp
    .split("\n")
    .flatMap((line, i) => (line.includes(`>"`) && line.includes(OWNER_FILE) ? [i] : []));
  const lineOf = (needle: string) => devUp.split("\n").findIndex((line) => line.includes(needle));

  it("is written in exactly one place", () => {
    expect(writes).toHaveLength(1);
  });

  it("is written after the collision check and after the stack came up", () => {
    const collisionExit = lineOf("is already running from another directory");
    const stackUp = lineOf('-p "$SLUG" up -d rome chrome');

    expect(collisionExit).toBeGreaterThan(-1);
    expect(stackUp).toBeGreaterThan(collisionExit);
    expect(writes[0]).toBeGreaterThan(stackUp);
  });
});
