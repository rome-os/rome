import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import {
  githubViaRomeHint,
  isRomeManagedToolkit,
  loadConnectorClient,
  romeManagedConnectHint,
  romeManagedToolExecuteHint,
  ROME_USER_ID,
} from "../../shared.js";

const log = createAppLogger("connector_tool_execute");

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe("Owning toolkit slug of the tool, e.g. 'gmail', 'github', 'slack'"),
  slug: z
    .string()
    .min(1)
    .describe("Tool slug to execute, e.g. 'GMAIL_SEND_EMAIL' (from connector_search)"),
  args: z
    .record(z.string(), z.unknown())
    .describe(
      "Arguments matching the tool's input schema (connector_tool_schema). Pass {} if the tool takes none.",
    ),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ toolkit, slug, args }) => {
      // Rome-managed toolkits have no Composio connection — they run through
      // Rome's own integration and are driven by connector_proxy. Redirect before
      // touching Composio so the agent never waits on a sign-in that can't
      // authorize their tools. GitHub also offers gh/git in the shell.
      if (isRomeManagedToolkit(toolkit)) {
        return {
          status: "error",
          error:
            toolkit.toLowerCase() === "github"
              ? githubViaRomeHint()
              : romeManagedToolExecuteHint(toolkit),
        };
      }
      const client = await loadConnectorClient();
      if (!client) {
        return {
          status: "error",
          error: `Not signed in to Composio. Call connector_login once to sign in, then re-run connector_tool_execute for "${slug}".`,
        };
      }
      try {
        // A tool authenticates as the guardian's managed connected account, so an
        // unconnected toolkit can't run. Resolve it explicitly and surface a clear
        // "connect first" error rather than letting Composio reject the call with
        // an opaque message — and fail loud on the duplicate-connection invariant
        // violation, mirroring connector_connect.
        const account = await client.findActiveConnectedAccount(ROME_USER_ID, toolkit);
        if (account.kind === "none") {
          return {
            status: "error",
            error: isRomeManagedToolkit(toolkit)
              ? romeManagedConnectHint(toolkit)
              : `Toolkit "${toolkit}" is not connected. Call connector_connect with toolkit "${toolkit}" first, then re-run connector_tool_execute.`,
          };
        }
        if (account.kind === "ambiguous") {
          return {
            status: "error",
            error: `Toolkit "${toolkit}" has ${account.ids.length} active managed connections — resolve the duplicate in the Connector dashboard before executing tools.`,
          };
        }
        const result = await client.executeTool({
          userId: ROME_USER_ID,
          connectedAccountId: account.id,
          slug,
          args,
        });
        // Fail closed on a tool-level refusal. Composio reports a rejected
        // upstream operation as `successful: false` inside an otherwise-200
        // response; surfacing that as `status: "ok"` would let callers (and the
        // workflow template) unwrap `.data` and march on as if it worked, since
        // the default runAction contract treats `status !== "ok"` as the only
        // failure signal. Map the refusal to an action-level error so the
        // contract fails closed; only a genuinely successful call returns `ok`,
        // with the tool's raw payload as `data`.
        if (!result.ok) {
          return {
            status: "error",
            error: `Tool "${slug}" failed: ${result.error ?? "the tool reported failure without an error message."}`,
          };
        }
        return { status: "ok", data: result.data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("tool execution failed", { slug, toolkit, error: message });
        return { status: "error", error: `Composio tool execution failed: ${message}` };
      }
    },
  });
}
