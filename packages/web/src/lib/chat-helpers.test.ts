import { describe, expect, it } from "@rstest/core";
import { detectAppInstalls, resolveAppToOpen } from "./chat-helpers";
import type { TraceBlockDto } from "@rome/api-types/trace-segments";

function actionResult(toolUseId: string, tool: string, payload: Record<string, unknown>) {
  return {
    type: "tool_result",
    tool,
    toolUseId,
    output: { content: [{ type: "text", text: JSON.stringify(payload) }] },
  } as unknown as TraceBlockDto;
}

describe("detectAppInstalls", () => {
  it("detects an execute_action install whose appId only appears in the result", () => {
    // Shape taken from a real import-skill trace: `op: "install"` carries no
    // appId (the daemon derives it from the source); the result reports it.
    const blocks = [
      {
        type: "tool_use",
        tool: "execute_action",
        id: "item_6",
        input: {
          action_name: "system:app_management",
          json_args: {
            op: "install",
            source: { mode: "source", path: "/rome-home/.rome/default/projects/apps/user-skills" },
          },
        },
      } as unknown as TraceBlockDto,
      actionResult("item_6", "execute_action", {
        appId: "user-skills",
        state: "installed",
        installedVersion: "0.1.0",
      }),
    ];

    expect(detectAppInstalls(blocks)).toEqual([{ appId: "user-skills" }]);
  });

  it("detects a direct app_management install without an input appId", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "system:app_management",
        id: "use-1",
        input: { op: "install", source: { mode: "bundle", path: "/tmp/artifact" } },
      } as unknown as TraceBlockDto,
      actionResult("use-1", "system:app_management", { appId: "my-app", state: "installed" }),
    ];

    expect(detectAppInstalls(blocks)).toEqual([{ appId: "my-app" }]);
  });

  it("detects a create op via the input appId", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "app_management",
        id: "use-2",
        input: { op: "create", appId: "fresh-app", rootPath: "/tmp/fresh-app" },
      } as unknown as TraceBlockDto,
      actionResult("use-2", "app_management", { state: "installed" }),
    ];

    expect(detectAppInstalls(blocks)).toEqual([{ appId: "fresh-app" }]);
  });

  it("does not treat another app's app_management action as a direct install", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "third-party:app_management",
        id: "use-third-party-direct",
        input: { op: "install" },
      } as unknown as TraceBlockDto,
      actionResult("use-third-party-direct", "third-party:app_management", {
        appId: "unrelated-app",
        state: "installed",
      }),
    ];

    expect(detectAppInstalls(blocks)).toEqual([]);
  });

  it("does not treat another app's app_management action as a wrapped install", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "execute_action",
        id: "use-third-party-wrapped",
        input: {
          action_name: "third-party:app_management",
          json_args: { op: "install" },
        },
      } as unknown as TraceBlockDto,
      actionResult("use-third-party-wrapped", "execute_action", {
        appId: "unrelated-app",
        state: "installed",
      }),
    ];

    expect(detectAppInstalls(blocks)).toEqual([]);
  });

  it("ignores installs whose result does not report state installed", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "app_management",
        id: "use-3",
        input: { op: "install", source: { mode: "source", path: "/tmp/broken-app" } },
      } as unknown as TraceBlockDto,
      actionResult("use-3", "app_management", {
        appId: "broken-app",
        state: "failed",
        error: "build failed",
      }),
    ];

    expect(detectAppInstalls(blocks)).toEqual([]);
  });

  it("ignores non-install ops and unrelated tools", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "app_management",
        id: "use-4",
        input: { op: "uninstall", appId: "old-app" },
      } as unknown as TraceBlockDto,
      actionResult("use-4", "app_management", { appId: "old-app", state: "installed" }),
      {
        type: "tool_use",
        tool: "list_actions",
        id: "use-5",
        input: {},
      } as unknown as TraceBlockDto,
    ];

    expect(detectAppInstalls(blocks)).toEqual([]);
  });

  it("still detects a Bash pnpm app:install run", () => {
    const blocks = [
      {
        type: "tool_use",
        tool: "Bash",
        id: "use-6",
        input: { command: "pnpm app:install --source ~/projects/apps/cli-app/" },
      } as unknown as TraceBlockDto,
      {
        type: "tool_result",
        tool: "Bash",
        toolUseId: "use-6",
        output: { exit_code: 0, aggregated_output: "installed" },
      } as unknown as TraceBlockDto,
    ];

    expect(detectAppInstalls(blocks)).toEqual([{ appId: "cli-app" }]);
  });
});

describe("resolveAppToOpen", () => {
  it("redirects the user-skills carrier to the Skills app", () => {
    expect(resolveAppToOpen("user-skills")).toBe("skills");
  });

  it("passes every other app through unchanged", () => {
    expect(resolveAppToOpen("skills")).toBe("skills");
    expect(resolveAppToOpen("my-app")).toBe("my-app");
  });
});
