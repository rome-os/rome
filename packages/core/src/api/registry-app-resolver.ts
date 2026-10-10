import type {
  AppRefDto,
  TraceSubagentStartEvent,
  ToolUseBlock,
} from "@rome/api-types/trace-segments";
import type { ActionRegistryImpl } from "../actions/registry.js";
import type { AgentLoader } from "../core/agent-loader.js";
import type { AppCatalog } from "../apps/catalog.js";
import { isResolvedApp, type ResolvedApp } from "../apps/state.js";
import {
  BUILTIN_TOOL_APPS,
  DISCOVERY_SHIM_TOOLS,
  SYSTEM_PSEUDO_APP,
  TOOL_TO_BUILTIN,
} from "./builtin-tool-apps.js";
import type { AppResolver } from "./trace-segments.js";
import { appIdToPathSegment } from "../apps/packaging/app-id.js";

export interface RegistryAppResolverDeps {
  appCatalog: AppCatalog;
  actionRegistry: Pick<ActionRegistryImpl, "getMetadata">;
  agentLoader: Pick<AgentLoader, "getAllRecords">;
}

interface CachedAppRef {
  version: string;
  ref: AppRefDto;
}

function isExecuteShim(tool: string): boolean {
  return tool === "execute" || tool === "execute_action";
}

function readActionName(input: unknown): string | undefined {
  if (input && typeof input === "object" && "action_name" in input) {
    const value = (input as { action_name?: unknown }).action_name;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function createRegistryAppResolver(deps: RegistryAppResolverDeps): AppResolver {
  const cache = new Map<string, CachedAppRef>();

  const refForApp = (appId: string): AppRefDto => {
    const view = deps.appCatalog.get(appId);
    if (!isResolvedApp(view)) return SYSTEM_PSEUDO_APP;

    const cached = cache.get(appId);
    if (cached && cached.version === view.manifest.version) return cached.ref;

    const ref: AppRefDto = {
      id: view.appId,
      name: view.displayName,
      iconUrl: view.iconAbsolutePath
        ? `/api/apps/${appIdToPathSegment(view.appId)}/icon`
        : "/icon.svg",
    };
    cache.set(appId, { version: view.manifest.version, ref });
    return ref;
  };

  const resolveAppOwnedAction = (actionName: string | undefined): AppRefDto | null => {
    if (!actionName) return null;
    const meta = deps.actionRegistry.getMetadata(actionName);
    if (!meta) return null;
    if (meta.ownerType !== "app") return SYSTEM_PSEUDO_APP;
    return refForApp(meta.ownerId);
  };

  return {
    resolveTool(block: ToolUseBlock | TraceSubagentStartEvent): AppRefDto {
      const tool = block.type === "subagent_start" ? block.agentName : block.tool;

      if (isExecuteShim(tool)) {
        const actionName = readActionName(block.input);
        const resolved = resolveAppOwnedAction(actionName);
        if (resolved) return resolved;
        return SYSTEM_PSEUDO_APP;
      }

      if (DISCOVERY_SHIM_TOOLS.has(tool)) return SYSTEM_PSEUDO_APP;

      const builtinKey = TOOL_TO_BUILTIN[tool];
      if (builtinKey) return BUILTIN_TOOL_APPS[builtinKey];

      const agentRecord = deps.agentLoader.getAllRecords().get(tool);
      if (agentRecord) {
        if (agentRecord.metadata.ownerType === "app") {
          return refForApp(agentRecord.metadata.ownerId);
        }
        return SYSTEM_PSEUDO_APP;
      }

      return SYSTEM_PSEUDO_APP;
    },
  };
}
