// The turn-audience guard on device actions. An agent's session carries
// ROME_TURN_AUDIENCE, and while it says the turn is shared, the CLI refuses
// the actions of a device's personal capabilities, such as an iPhone's
// Health. A guardrail against a model mistake, not a security boundary: the
// agent can unset the variable. Rule: docs/domains/participation.md#audience.

import { actionError, isRecord, type ActionResponse } from "@rome-os/node-core";

export const PERSONAL_DATA_PRIVATE_ONLY =
  "This chat is not private, so personal data (Apple Health and other synced data) cannot be " +
  "read here. Ask the guardian to ask you in a private chat with Rome, such as the Rome app or a " +
  "direct message.";

/** Capabilities that are personal on every device, whatever it reports. */
const PERSONAL_PREFIXES: ReadonlySet<string> = new Set(["health"]);

/** A computer's own actions, which read no personal data and need no lookup. */
const HOST_ACTIONS: ReadonlySet<string> = new Set(["system.info", "exec", "fs.list"]);

/** Whether the environment says the turn is shared. Unset means a person runs the CLI. */
export function turnIsShared(env: NodeJS.ProcessEnv): boolean {
  const audience = env.ROME_TURN_AUDIENCE;
  return audience !== undefined && audience !== "private";
}

/** Whether `action` may run without asking the device what it is. */
export function knownNotPersonal(action: string): boolean {
  return HOST_ACTIONS.has(action);
}

/**
 * Whether `action` belongs to a personal capability, by its prefix: the text
 * before the first dot. `info` is the device's `system.info` answer, whose
 * `capabilities` mark each one `personal`.
 */
export function isPersonalAction(action: string, info: ActionResponse | undefined): boolean {
  const prefix = action.split(".")[0];
  if (PERSONAL_PREFIXES.has(prefix)) return true;
  const capabilities =
    info?.ok && isRecord(info.result) && Array.isArray(info.result.capabilities)
      ? info.result.capabilities
      : [];
  return capabilities.some(
    (capability) =>
      isRecord(capability) && capability.prefix === prefix && capability.personal === true,
  );
}

export function personalDataRefusal(): ActionResponse {
  return actionError("personal_data_private_only", PERSONAL_DATA_PRIVATE_ONLY);
}
