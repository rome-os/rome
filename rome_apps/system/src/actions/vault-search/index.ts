import { defineAction, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig } from "@rome-os/app-runtime";
import { signerRequest } from "../vault-signer.js";
import type { VaultSearchOutput, VaultSearchSecret } from "./types.js";
export type { VaultSearchInput, VaultSearchOutput, VaultSearchSecret } from "./types.js";

export const vaultSearchInputSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Text matched against secret names and descriptions. Omit to list every secret."),
});

export function createAction(config: ActionConfig): Action {
  return defineAction({
    config,
    schema: vaultSearchInputSchema,
    execute: async ({ query }) => {
      let reply: Awaited<ReturnType<typeof signerRequest>>;
      try {
        reply = await signerRequest("GET", "/v1/secrets");
      } catch (error) {
        return { status: "error", error: (error as Error).message };
      }
      if (reply.status !== 200) return { status: "error", error: "The vault could not be read." };
      const needle = query?.trim().toLowerCase();
      const secrets = (reply.body.secrets as VaultSearchSecret[])
        .filter(
          (secret) =>
            !needle ||
            secret.name.toLowerCase().includes(needle) ||
            secret.description.toLowerCase().includes(needle),
        )
        .map(({ name, description, lastUsedAt, grantedUntil }) => ({
          name,
          description,
          lastUsedAt,
          ...(grantedUntil ? { grantedUntil } : {}),
        }));
      const data: VaultSearchOutput = { secrets };
      return { status: "ok", data };
    },
  });
}
