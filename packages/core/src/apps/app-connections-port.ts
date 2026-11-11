// How an app reaches connected accounts' APIs through `ctx.connections`. Apps
// says what an app gets; Connections supplies it.

import {
  AppConnectionError,
  type AppConnectionDescription,
  type AppConnectionInvokeResult,
  type AppConnectionOperationsPage,
  type AppConnectionPage,
  type AppConnectionsCapability,
} from "@rome-os/app-runtime";

/** Gives each app its own `ctx.connections`. */
export interface AppConnectionsContextFactory {
  forApp(appId: string): AppConnectionsCapability;
}

/** `ctx.connections` for an app with no connection access: every call is refused. */
export class DeniedAppConnections implements AppConnectionsCapability {
  private denied(): never {
    throw new AppConnectionError({
      code: "access_denied",
      message: "This App has no connection access.",
      retryable: false,
    });
  }

  async list(): Promise<AppConnectionPage> {
    return this.denied();
  }
  async describe(): Promise<AppConnectionDescription> {
    return this.denied();
  }
  async operations(): Promise<AppConnectionOperationsPage> {
    return this.denied();
  }
  async invoke<T = unknown>(): Promise<AppConnectionInvokeResult<T>> {
    return this.denied();
  }
}
