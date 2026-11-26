import { isRecord } from "../actions.js";
import { isUuid } from "../frame.js";
import { requestParams, type ActParams } from "./protocol.js";

export function computerUseAuditFields(
  action: string,
  args: unknown,
): { actionId?: string; operation?: ActParams["action"] } {
  if (action !== "computer.act" || !isRecord(args)) return {};
  const { actionId, ...input } = args;
  if (!isUuid(actionId)) return {};
  const id = actionId.toLowerCase();
  try {
    return { actionId: id, operation: requestParams("act", input).action };
  } catch {
    return { actionId: id };
  }
}
