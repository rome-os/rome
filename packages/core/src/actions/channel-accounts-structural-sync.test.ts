import { describe, expect, it } from "@rstest/core";
import type { ChannelAccountsService as Core } from "../channels/channel-accounts.js";
import type { ChannelAccountsService as Action } from "../../../../rome_apps/system/src/actions/send-message/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
const inSync: Equal<Awaited<ReturnType<Core["find"]>>, Awaited<ReturnType<Action["find"]>>> &
  Equal<Parameters<Core["find"]>, Parameters<Action["find"]>> = true;

describe("channel accounts structural contract", () => {
  it("matches core and action (enforced by typecheck)", () => {
    expect(inSync).toBe(true);
  });
});
