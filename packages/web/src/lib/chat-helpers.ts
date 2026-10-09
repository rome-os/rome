import { escapeMarkdownText } from "./markdown-text";
import type { TraceEventDto } from "@rome/api-types/trace-segments";
import type { ApprovalRecord, PendingUpload, ReasoningEffort } from "./chat-types";

export interface AppInstalledEvent {
  appId: string;
  displayName?: string;
}

function isSystemAppManagementAction(name: unknown): name is string {
  return name === "app_management" || name === "system:app_management";
}

function parseInstallSuccess(output: unknown): { appId?: string } | null {
  if (!output || typeof output !== "object") return null;
  const fromRecord = (obj: Record<string, unknown>): { appId?: string } | null =>
    obj.state === "installed"
      ? { appId: typeof obj.appId === "string" ? obj.appId : undefined }
      : null;
  const obj = output as Record<string, unknown>;
  const direct = fromRecord(obj);
  if (direct) return direct;
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
        const text = (item as Record<string, unknown>).text;
        if (typeof text !== "string") continue;
        try {
          const parsed = fromRecord(JSON.parse(text) as Record<string, unknown>);
          if (parsed) return parsed;
        } catch {}
      }
    }
  }
  return null;
}

export function detectAppInstalls(blocks: TraceEventDto[]): AppInstalledEvent[] {
  const results: AppInstalledEvent[] = [];

  const resultMap = new Map<string, TraceEventDto>();
  // tool_use id → appId from the input ("create" carries one), or null when it
  // can only come from the result ("install" takes NO appId by contract — the
  // daemon derives it from the source and returns it in the result).
  const installUseMap = new Map<string, string | null>();
  const recordInstallUse = (id: string, args: Record<string, unknown> | null): void => {
    if (args?.op === "install") {
      installUseMap.set(id, null);
    } else if (args?.op === "create" && typeof args.appId === "string") {
      installUseMap.set(id, args.appId);
    }
  };
  for (const block of blocks) {
    if (block.type === "tool_result" && block.toolUseId) {
      resultMap.set(block.toolUseId, block);
    }
    if (block.type !== "tool_use" || !block.id) continue;
    if (isSystemAppManagementAction(block.tool)) {
      recordInstallUse(block.id, block.input as Record<string, unknown> | null);
    } else if (block.tool === "execute_action") {
      const input = block.input as Record<string, unknown> | null;
      const actionName = input?.action_name ?? input?.name;
      if (isSystemAppManagementAction(actionName)) {
        recordInstallUse(
          block.id,
          (input?.json_args ?? input?.input) as Record<string, unknown> | null,
        );
      }
    }
  }
  for (const block of blocks) {
    if (block.type !== "tool_result" || !block.toolUseId) continue;
    const inputAppId = installUseMap.get(block.toolUseId);
    if (inputAppId === undefined) continue;
    const installed = parseInstallSuccess(block.output);
    if (!installed) continue;
    const appId = inputAppId ?? installed.appId;
    if (appId) results.push({ appId });
  }

  for (const block of blocks) {
    if (block.type !== "tool_use" || block.tool !== "Bash" || !block.id) continue;
    const input = block.input as Record<string, unknown> | null;
    // A background run returns before the install finishes, so its result
    // says nothing about whether the install succeeded.
    if (input?.run_in_background === true) continue;
    const cmd = typeof input?.command === "string" ? input.command : "";
    if (!cmd.includes("app:install")) continue;
    const match = cmd.match(/\/apps\/([a-z][a-z0-9-]*)\//);
    if (!match) continue;
    const appId = match[1];
    const resultBlock = resultMap.get(block.id);
    if (!resultBlock || resultBlock.type !== "tool_result") continue;
    if (!bashSucceeded(resultBlock)) continue;
    results.push({ appId });
  }

  return results;
}

/** Whether a Bash tool result succeeded. A result without `isError` (recorded
 *  before the flag existed, or from a producer that cannot tell) falls back
 *  to the shell's exit code. */
function bashSucceeded(result: Extract<TraceEventDto, { type: "tool_result" }>): boolean {
  if (result.isError !== undefined) return !result.isError;
  const out = result.output as Record<string, unknown> | null;
  return (out?.exit_code ?? out?.exitCode) === 0;
}

// A few apps are carriers, not destinations: their own page is just a redirect.
// `user-skills` is the bucket the import-skill skill installs into — opening it
// drops the guardian on a dead-end pointer, so surface the Skills app instead.
const CARRIER_REDIRECTS: Record<string, string> = { "user-skills": "skills" };

/** When chat would auto-open `appId` after an install, this is the app to
 * actually surface. Detection stays honest about what was installed; only the
 * thing we *show* is redirected. Pass-through for every non-carrier app. */
export function resolveAppToOpen(appId: string): string {
  return CARRIER_REDIRECTS[appId] ?? appId;
}

export function sameApproval(a: ApprovalRecord | null, b: ApprovalRecord): boolean {
  if (!a) return false;
  return (
    a.id === b.id &&
    a.status === b.status &&
    (a.executionState ?? null) === (b.executionState ?? null) &&
    (a.executionError ?? null) === (b.executionError ?? null)
  );
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "high" || value === "xhigh";
}

export function getProjectDisplayName(projectName: string): string {
  const segments = projectName.split("/").filter(Boolean);
  return segments.at(-1) ?? projectName;
}

export function buildOptimisticUserText(
  text: string,
  uploads: Pick<PendingUpload, "file">[],
): string {
  const promptText = text.trim();

  if (uploads.length === 0) {
    return promptText;
  }

  const lines = uploads.map(
    (upload, index) => `- File ${index + 1}: ${escapeMarkdownText(upload.file.name)}`,
  );

  return [promptText, lines.join("\n")].filter(Boolean).join("\n\n").trim();
}
