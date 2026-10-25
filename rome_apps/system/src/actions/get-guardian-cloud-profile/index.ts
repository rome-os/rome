import type { Action, ActionConfig, ActionResult } from "@rome-os/app-runtime";

/** Structural copies of core's guardian-profile contract. Keep in sync: apps
 * cannot import core, and workers receive a proxy instead of the real client. */
export type CloudProfile = Record<string, unknown>;

export type CloudProfileOutcome =
  | { kind: "ok"; profile: CloudProfile }
  | { kind: "unavailable"; reason: string };

export interface CloudProfileService {
  get(): Promise<CloudProfileOutcome>;
}

export function createAction(
  config: ActionConfig,
  deps: { cloudProfile?: CloudProfileService },
): Action {
  const service = deps.cloudProfile;
  if (typeof service?.get !== "function") {
    throw new Error("get_guardian_cloud_profile requires a cloudProfile capability");
  }
  return {
    config,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute(): Promise<ActionResult> {
      const outcome = await service.get();
      if (outcome.kind === "ok") return { status: "ok", data: outcome.profile };
      return { status: "error", error: `guardian_profile_unavailable: ${outcome.reason}` };
    },
  };
}
