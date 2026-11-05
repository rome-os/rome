import type { SubagentExecution } from "./subagent-execution.js";

export interface ParentSubagentRef {
  sessionId: string;
  turnId: string;
  toolUseId: string;
}

export interface ChildSubagentRef {
  sessionId: string;
  turnId: string;
}

export interface ActiveSubagentLink {
  parent: ParentSubagentRef;
  child: ChildSubagentRef;
  execution: SubagentExecution;
}

export interface ActiveSubagentRegistry {
  register(parent: ParentSubagentRef, child: ChildSubagentRef, execution: SubagentExecution): void;
  getLinkByParent(parent: ParentSubagentRef): ActiveSubagentLink | undefined;
  getLinkByChild(child: ChildSubagentRef): ActiveSubagentLink | undefined;
  clearByParent(parent: ParentSubagentRef): void;
}

const parentKey = (ref: ParentSubagentRef): string =>
  `${ref.sessionId}\u0000${ref.turnId}\u0000${ref.toolUseId}`;

const childKey = (ref: ChildSubagentRef): string => `${ref.sessionId}\u0000${ref.turnId}`;

export function createActiveSubagentRegistry(): ActiveSubagentRegistry {
  const byParent = new Map<string, ActiveSubagentLink>();
  const byChild = new Map<string, ActiveSubagentLink>();

  return {
    register(parent, child, execution) {
      const pk = parentKey(parent);
      const ck = childKey(child);
      if (byParent.has(pk)) {
        throw new Error(
          `Active subagent link already exists for parent ${parent.sessionId}/${parent.turnId}/${parent.toolUseId}`,
        );
      }
      if (byChild.has(ck)) {
        throw new Error(
          `Active subagent link already exists for child ${child.sessionId}/${child.turnId}`,
        );
      }
      const link = { parent, child, execution };
      byParent.set(pk, link);
      byChild.set(ck, link);
    },

    getLinkByParent(parent) {
      return byParent.get(parentKey(parent));
    },

    getLinkByChild(child) {
      return byChild.get(childKey(child));
    },

    clearByParent(parent) {
      const pk = parentKey(parent);
      const link = byParent.get(pk);
      if (!link) return;
      byParent.delete(pk);
      byChild.delete(childKey(link.child));
    },
  };
}
