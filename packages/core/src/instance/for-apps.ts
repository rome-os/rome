// What Instance offers apps. An app's action worker runs in its own process,
// and these calls run in the main process, where the instance's credentials
// and the upgrade countdown live.

import { feedbackSendSchema, type FeedbackService } from "../lib/feedback-client.js";
import type { CloudProfileService } from "./cloud-profile.js";
import type { SystemUpgradeChecker } from "./system-upgrade/service.js";

export interface InstanceWorkerCallsDeps {
  /** Runs where the upgrade countdown it opens lives. */
  systemUpgrade: SystemUpgradeChecker;
  feedback: FeedbackService;
  /** What `system:get_guardian_cloud_profile` reads from Rome Cloud. */
  cloudProfile: CloudProfileService;
}

/** The instance calls an app's worker makes, keyed by method name. */
export function instanceWorkerCalls(
  deps: InstanceWorkerCallsDeps,
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    "system.upgrade.checkAndOffer": () => deps.systemUpgrade.checkAndOffer(),
    "feedback.send": async (params) => {
      const result = feedbackSendSchema.safeParse(params);
      if (!result.success) {
        const issues = result.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new Error(`feedback.send: invalid params — ${issues}`);
      }
      return deps.feedback.send(result.data);
    },
    "cloudProfile.get": () => deps.cloudProfile.get(),
  };
}
