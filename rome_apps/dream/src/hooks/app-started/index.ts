import type { AppStartedHook, AppStartedHookDeps } from "@rome-os/app-runtime";
import { ensureDailyDreamRoutine } from "../../lib/daily-routine.js";

export function createHook(deps: AppStartedHookDeps): AppStartedHook {
  return {
    async onAppStarted() {
      if ((await ensureDailyDreamRoutine(deps.appContext)) === "created") {
        deps.logger.info("registered the daily dream routine");
      }
    },
  };
}
