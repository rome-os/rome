import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  isComputerOperation,
  signedComputerRequest,
  signComputerRequest,
  type ComputerAuthorization,
} from "@rome-os/node-core/computer-origin";
import { browserChatInput, type RomeTool, type TurnFacts } from "../agent/index.js";
import type { DeviceRunResult } from "../desktops/node-devices.js";
import type { PrivateTurn } from "./share-location-tool.js";

const deviceId = z.uuid().refine((id) => id === id.toLowerCase());
const grants = z.strictObject({
  local: z.boolean().default(false),
  instance: z
    .strictObject({
      peer: deviceId,
      privateKeyFile: z.string().startsWith("/"),
      targets: z.record(deviceId, z.array(z.string().refine(isComputerOperation)).min(1)),
    })
    .optional(),
});

export async function readComputerGrants(path: string, sessionSecret: string) {
  if (sessionSecret.length < 32)
    throw new Error(
      "Computer Use requires an instance-specific session secret of at least 32 characters.",
    );
  const grant = grants.parse(JSON.parse(await readFile(path, "utf8")));
  const key = grant.instance && createPrivateKey(await readFile(grant.instance.privateKeyFile));
  if (key && key.asymmetricKeyType !== "ed25519")
    throw new Error("Computer Use requires an Ed25519 private key.");
  return {
    local: grant.local,
    instance: grant.instance && key ? { ...grant.instance, key } : undefined,
  };
}

interface ComputerToolOptions {
  grants: {
    local: boolean;
    instance?: { peer: string; key: KeyObject; targets: Record<string, string[]> };
  };
  localStatus(): Promise<unknown>;
  run(
    device: string,
    action: string,
    args: unknown,
    proof?: ComputerAuthorization,
  ): Promise<DeviceRunResult>;
}

const report = z.object({
  actions: z.array(z.string()).max(128),
  audit: z.object({ state: z.literal("ok") }),
  computerUsePilot: z.object({
    epoch: deviceId,
    signedRequest: z.object({
      type: z.literal(signedComputerRequest.type),
      protocol: z.literal(signedComputerRequest.protocol),
      algorithm: z.literal(signedComputerRequest.algorithm),
    }),
  }),
});

const inputSchema = z.strictObject({
  target: z.string().optional(),
  operation: z.string().refine(isComputerOperation).optional(),
  args: z.record(z.string(), z.json()).optional(),
});

export function computerUseTool(
  options: ComputerToolOptions,
  turn: TurnFacts,
  hasSpeaker: boolean,
  privateTurn?: PrivateTurn,
): RomeTool {
  const { local, instance } = options.grants;
  const targets = [...(local ? ["local"] : []), ...Object.keys(instance?.targets ?? {})];
  const denied = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
  const answer = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });
  return {
    name: "computer_use",
    description:
      "Call with no arguments to list approved targets, then a target alone to list its available operations. Run an advertised operation only on the computer the guardian asks to use.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string" },
        operation: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
    },
    async handler(input) {
      const turnId = turn.turnId();
      const chatId = turn.threadContext()?.threadId;
      const actor = turn.actor();
      const source = actor?.[browserChatInput];
      const current = () =>
        !!turnId &&
        !!chatId &&
        hasSpeaker &&
        !turn.isSubagent &&
        turn.live?.() === true &&
        turn.turnId() === turnId &&
        turn.threadContext()?.channel === "webchat" &&
        turn.threadContext()?.threadId === chatId &&
        turn.audience() === "private" &&
        actor?.kind === "guardian" &&
        !!source &&
        turn.actor() === actor;
      const authorized = () => current() && privateTurn?.(turn);
      const refusal = () =>
        denied(
          "computer_origin_required: This operation requires a private message from the guardian's signed-in browser.",
        );
      if (!(await authorized()) || !current()) return refusal();
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success)
        return denied(
          "invalid_request: Expected a target, optional computer operation and JSON object arguments.",
        );
      const { target, operation, args = {} } = parsed.data;
      if (target === undefined) {
        if (operation !== undefined || parsed.data.args !== undefined)
          return denied("invalid_request: Choose a target for this operation.");
        return answer({
          targets: targets.filter((id) =>
            id === "local" ? source !== "instance" : source !== "local-password",
          ),
        });
      }
      if (!targets.includes(target))
        return denied("computer_target_unapproved: This computer has no grant.");
      if (target === "local") {
        if (source === "instance") return refusal();
        if (!operation) return answer({ actions: ["computer.status"] });
        if (operation !== "computer.status")
          return denied("unsupported_action: The local computer does not offer this operation.");
        const status = await options.localStatus();
        return (await authorized()) && current() ? answer(status) : refusal();
      }
      if (source === "local-password") return refusal();
      if (!instance) return denied("computer_target_unapproved");
      const info = await options.run(target, "system.info", {});
      if (!(await authorized()) || !current()) return refusal();
      if (!info.ok) return denied(info.code);
      const advertised = report.safeParse(info.result);
      if (!advertised.success)
        return denied(
          "computer_protocol_unsupported: The target did not advertise the signed request protocol.",
        );
      const actions = advertised.data.actions.filter((action) =>
        instance.targets[target].includes(action),
      );
      if (!operation) return answer({ actions });
      if (!actions.includes(operation))
        return denied("unsupported_action: This operation is unavailable for this target.");
      const proof = signComputerRequest(instance.key, {
        peer: instance.peer,
        deviceId: target,
        epoch: advertised.data.computerUsePilot.epoch,
        action: operation,
        args,
      });
      const result = await options.run(target, operation, args, proof);
      if (!(await authorized()) || !current()) return refusal();
      return result.ok ? answer(result.result) : denied(result.code);
    },
  };
}
