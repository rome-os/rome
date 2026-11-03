import type { AppStartedHook, AppStartedHookDeps } from "@rome-os/app-runtime";
import { ensureDreamRoutine } from "../../lib/dream-routine.js";

export function createHook(deps: AppStartedHookDeps): AppStartedHook {
  return {
    async onAppStarted() {
      const outcome = await ensureDreamRoutine(deps.appContext);
      if (outcome === "created") deps.logger.info("registered the dream routine");
      if (outcome === "replaced") deps.logger.info("replaced the daily dream routine");
    },
  };
}
