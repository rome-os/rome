import { describe, expect, it } from "@rstest/core";
import type { AgentNamesService as Core } from "../channels/agent-names.js";
import type { AgentNamesService as Action } from "../../../../rome_apps/system/src/actions/send-message/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const inSync: Equal<Awaited<ReturnType<Core["resolve"]>>, Awaited<ReturnType<Action["resolve"]>>> &
  Equal<Parameters<Core["resolve"]>, Parameters<Action["resolve"]>> = true;

describe("agent names structural contract", () => {
  it("matches core and action (enforced by typecheck)", () => {
    expect(inSync).toBe(true);
  });
});
