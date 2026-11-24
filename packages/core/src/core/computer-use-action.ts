import { COMPUTER_USE_ACTION } from "../agent/index.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { ActionRegistry } from "../apps/actions/types.js";
import type { ThreadContext } from "./types.js";

/** Discovery is useful on its own; allowing this action also enables the computer tools. */
export function registerComputerUseAction(
  registry: Pick<ActionRegistry, "register">,
  devices: { listDevices(): Promise<unknown> },
  audience: (context: ThreadContext | undefined) => Promise<"private" | "shared">,
): void {
  registry.register({
    config: {
      name: COMPUTER_USE_ACTION,
      type: "system",
      description:
        "List the guardian's authorized computers. Allowing this action also enables the " +
        "computer_* tools to observe and control supported windows in a private guardian " +
        "chat. Use those tools for window discovery, binding, observation, action, verification " +
        "and cancellation. Execution never falls back to shell commands.",
      complexity: "simple",
      speed: "fast",
      reliability: "medium",
      sideEffects: "write",
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const turn = actionExecutionContext.getStore();
      const admitted = async () =>
        turn?.actor?.kind === "guardian" &&
        turn.audience === "private" &&
        (await audience(turn.channelContext)) === "private";
      if (!(await admitted())) {
        return { status: "error", error: "computer_use_private_guardian_only" };
      }
      const data = await devices.listDevices();
      if (!(await admitted()))
        return { status: "error", error: "computer_use_private_guardian_only" };
      return { status: "ok", data };
    },
  });
}
