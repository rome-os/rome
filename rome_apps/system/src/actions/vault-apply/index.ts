import { defineAction, z } from "@rome-os/app-runtime";
import type { Action, ActionConfig } from "@rome-os/app-runtime";
import { signerRequest } from "../vault-signer.js";
import type { VaultApplyOutput } from "./types.js";
export type { VaultApplyInput, VaultApplyOutput } from "./types.js";

const DEFAULT_TTL_MINUTES = 15;
const MAX_NAMES = 10;

const secretName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/);

export const vaultApplyInputSchema = z
  .object({
    names: z
      .array(secretName)
      .min(1)
      .max(MAX_NAMES)
      .refine((names) => new Set(names).size === names.length, "Name each secret once.")
      .optional()
      .describe(
        "The names of the secrets, as listed by system:vault_search. One to 10, each once.",
      ),
    name: secretName
      .optional()
      .describe("One secret's name. The same as `names` with one entry. Give `names` or `name`."),
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
  .strict()
  .refine(({ names, name }) => (names === undefined) !== (name === undefined), {
    message: "Give exactly one of `names` and `name`.",
  });

/** The names a request asks for. The schema guarantees exactly one of the two fields. */
const namesOf = ({ names, name }: { names?: string[]; name?: string }): string[] =>
  names ?? [name as string];

const joinNames = (names: string[]): string =>
  names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function createAction(config: ActionConfig): Action {
  return defineAction({
    config,
    schema: vaultApplyInputSchema,
    // `title` and `summary` say the same in words, for surfaces that draw only the generic card.
    // `name` is the first name, for a reader that predates several.
    preview: (input) => {
      const names = namesOf(input);
      const { ttlMinutes = DEFAULT_TTL_MINUTES, reason } = input;
      return {
        kind: "secret_access",
        name: names[0],
        names,
        ttlMinutes,
        reason,
        title: `Use ${names.join(", ")} for ${ttlMinutes} min`,
        summary: reason,
      };
    },
    // The guardian's PIN approval on the card creates the grants before this runs.
    // The action only reports them: a run that finds one missing was not approved with a PIN.
    execute: async (input) => {
      const names = namesOf(input);
      let reply: Awaited<ReturnType<typeof signerRequest>>;
      try {
        reply = await signerRequest("GET", "/v1/secrets");
      } catch (error) {
        return { status: "error", error: (error as Error).message };
      }
      if (reply.status !== 200 || !Array.isArray(reply.body.secrets)) {
        return { status: "error", error: "The vault could not be read." };
      }
      const stored = new Map(
        (reply.body.secrets as Array<{ name: string; grantedUntil?: string }>).map((secret) => [
          secret.name,
          secret,
        ]),
      );
      const unknown = names.filter((name) => !stored.has(name));
      if (unknown.length > 0) {
        return {
          status: "error",
          error: `There is no secret named ${unknown.join(", ")}. Use system:vault_search for the names, or ask the guardian to add it in Settings, Advanced, Vault.`,
        };
      }
      const ungranted = names.filter((name) => !stored.get(name)?.grantedUntil);
      if (ungranted.length > 0) {
        return {
          status: "error",
          error: `There is no grant for ${ungranted.join(", ")}. The guardian approves system:vault_apply with the PIN in the dashboard.`,
        };
      }
      const expiresAt = names
        .map((name) => stored.get(name)?.grantedUntil as string)
        .reduce((earliest, until) => (Date.parse(until) < Date.parse(earliest) ? until : earliest));
      const data: VaultApplyOutput = {
        name: names[0],
        names,
        expiresAt,
        message: `Approved. Run \`vault load ${names.join(",")} -- <command>\` before ${expiresAt}. The command gets ${joinNames(names)} in its environment, and its output is masked.`,
      };
      return { status: "ok", data };
    },
  });
}
