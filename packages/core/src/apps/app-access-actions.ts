// The agent actions that read and set who may open an app. They call the same
// functions as `/api/public-access/:appId`.

import type { PreviewPayload } from "@rome-os/app-runtime";
import type { Permissions } from "../access/permissions.js";
import type { DrizzleDb } from "../db/index.js";
import { actionExecutionContext } from "./actions/context.js";
import type { ActionRegistry } from "./actions/types.js";
import {
  appAccessOf,
  isAppAccessRefusal,
  loadAppPermissionsSetting,
  parseAppAccess,
  setAppAccess,
  widensAppAccess,
  type AppAccess,
  type ShareableApps,
} from "./app-permissions.js";

export const APP_ACCESS_ACTIONS = {
  read: "core:apps_access_read",
  narrow: "core:apps_access_narrow",
  update: "core:apps_access_update",
} as const;

const MODES_TEXT =
  "private: only the guardian. public: anyone with the link. cloud-email: visitors who sign in with Rome Cloud as one of the listed emails.";

const SET_INPUT = {
  type: "object",
  required: ["appId", "mode"],
  properties: {
    appId: { type: "string", description: "The installed app's id." },
    mode: { type: "string", enum: ["private", "public", "cloud-email"], description: MODES_TEXT },
    emails: {
      type: "array",
      items: { type: "string" },
      description: "For cloud-email only: every email that may open the app, not just new ones.",
    },
  },
  additionalProperties: false,
};

function describe(access: AppAccess): string {
  if (access.mode === "public") return "anyone with the link";
  if (access.mode === "private") return "only the guardian";
  return access.emails.join(", ");
}

/** Registers the read, narrow and update actions for who may open an app. Guardian only. */
export function registerAppAccessActions(
  actions: Pick<ActionRegistry, "register">,
  deps: {
    db: DrizzleDb;
    permissions: Permissions;
    apps: ShareableApps;
    /** Whose chat it is ("guardian" or "visitor:<account>"), or null for a chat that no longer exists. */
    ownerOfChat(chatId: string | null | undefined): Promise<string | null>;
  },
): void {
  const notGuardian = { status: "error" as const, error: "Only the guardian can do this." };

  // Autonomous turns have no session actor, so the stored chat owner decides.
  const askedByGuardian = async (): Promise<boolean> => {
    const context = actionExecutionContext.getStore();
    const actor = context?.actor;
    if (actor && actor.kind !== "guardian") return false;
    const thread = context?.channelContext;
    const owner =
      thread?.channel === "webchat" && thread.threadId
        ? await deps.ownerOfChat(thread.threadId)
        : null;
    if (thread?.channel === "webchat" && owner !== "guardian") return false;
    return Boolean(actor) || owner === "guardian";
  };

  const set = async (args: Record<string, unknown>, onlyNarrow: boolean) => {
    if (!(await askedByGuardian())) return notGuardian;
    const appId = String(args.appId ?? "");
    const access = parseAppAccess(args);
    if (isAppAccessRefusal(access)) return { status: "error" as const, error: access.message };
    if (onlyNarrow) {
      const before = appAccessOf(await loadAppPermissionsSetting(deps.db), appId);
      if (widensAppAccess(before, access)) {
        return {
          status: "error" as const,
          error: `This lets more people open "${appId}". Use ${APP_ACCESS_ACTIONS.update}, which asks the guardian first.`,
        };
      }
    }
    const result = await setAppAccess(deps, appId, access);
    if (isAppAccessRefusal(result)) return { status: "error" as const, error: result.message };
    return { status: "ok" as const, data: { appId, ...result } };
  };

  actions.register({
    config: {
      name: APP_ACCESS_ACTIONS.read,
      type: "system",
      description: `Read who may open an installed app through its public link. ${MODES_TEXT} Guardian only.`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: {
      type: "object",
      required: ["appId"],
      properties: { appId: { type: "string", description: "The installed app's id." } },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (!(await askedByGuardian())) return notGuardian;
      const appId = String(args.appId ?? "");
      if (deps.apps.hasPage(appId) === null) {
        return { status: "error", error: `No installed app "${appId}".` };
      }
      const access = appAccessOf(await loadAppPermissionsSetting(deps.db), appId);
      return { status: "ok", data: { appId, ...access } };
    },
  });

  actions.register({
    config: {
      name: APP_ACCESS_ACTIONS.narrow,
      type: "system",
      description: `Let fewer people open an installed app: make it private, or remove emails from its list. Runs at once. Refuses a change that lets anyone new in; use ${APP_ACCESS_ACTIONS.update} for that. Guardian only.`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: SET_INPUT,
    execute: (args) => set(args, true),
  });

  actions.register({
    config: {
      name: APP_ACCESS_ACTIONS.update,
      type: "system",
      description: `Set who may open an installed app through its public link. The guardian approves the change before it is made. Only apps with a page can be shared. Guardian only.`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
      requiresApproval: true,
    },
    inputSchema: SET_INPUT,
    execute: (args) => set(args, false),
    preview: async (args): Promise<PreviewPayload | undefined> => {
      const access = parseAppAccess(args);
      if (isAppAccessRefusal(access)) return undefined;
      const appId = String(args.appId ?? "");
      const before = appAccessOf(await loadAppPermissionsSetting(deps.db), appId);
      return {
        kind: "generic",
        title: `Change who may open ${appId}`,
        summary: `From ${describe(before)} to ${describe(access)}.`,
        fields: [
          { label: "App", value: appId },
          { label: "Now", value: describe(before) },
          { label: "After", value: describe(access) },
        ],
      };
    },
  });
}
