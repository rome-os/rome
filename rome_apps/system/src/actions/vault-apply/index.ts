import { defineAction, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig } from "@rome-os/app-runtime";
import { signerRequest } from "../vault-signer.js";
import type { VaultApplyOutput } from "./types.js";
export type { VaultApplyInput, VaultApplyOutput } from "./types.js";

const DEFAULT_TTL_MINUTES = 15;

export const vaultApplyInputSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,63}$/)
      .describe("The secret's name, as listed by vault_search."),
    ttlMinutes: z
      .number()
      .int()
      .min(1)
      .max(180)
      .optional()
      .describe("Minutes the grant lasts. Defaults to 15, at most 180."),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("Why you need it, in one short sentence. The guardian reads this."),
  })
  .strict();

export function createAction(config: ActionConfig): Action {
  return defineAction({
    config,
    schema: vaultApplyInputSchema,
    // `title` and `summary` say the same in words, for surfaces that draw only the generic card.
    preview: ({ name, ttlMinutes = DEFAULT_TTL_MINUTES, reason }) => ({
      kind: "secret_access",
      name,
      ttlMinutes,
      reason,
      title: `Use ${name} for ${ttlMinutes} min`,
      summary: reason,
    }),
    execute: async ({ name, ttlMinutes = DEFAULT_TTL_MINUTES }) => {
      let reply: Awaited<ReturnType<typeof signerRequest>>;
      try {
        reply = await signerRequest("POST", "/v1/grants", { name, ttlSeconds: ttlMinutes * 60 });
      } catch (error) {
        return { status: "error", error: (error as Error).message };
      }
      if (reply.status === 404) {
        return {
          status: "error",
          error: `There is no secret named ${name}. Use vault_search for the names, or ask the guardian to add it in Settings, Advanced, Vault.`,
        };
      }
      if (reply.status !== 200 || typeof reply.body.expiresAt !== "string") {
        return { status: "error", error: "The vault could not grant the secret." };
      }
      const data: VaultApplyOutput = {
        name,
        expiresAt: reply.body.expiresAt,
        message: `Approved. Run \`vault load ${name} -- <command>\` before ${reply.body.expiresAt}. The command gets ${name} in its environment, and its output is masked.`,
      };
      return { status: "ok", data };
    },
  });
}
