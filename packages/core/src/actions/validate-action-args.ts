import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const argsSchemaValidator = new Ajv2020({ allErrors: true, strict: false });
const compiledArgsSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

/** Check routine args against the bound action's input schema, so a routine
 * can't be saved with args that fail on every fire. Shared by
 * `POST /api/routines` (the card's "Turn it on") and `propose_routine`'s
 * auto-enable gate. Returns an error message, or null when the args fit (or
 * the action declares no schema). */
export function validateActionArgs(
  actionName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (!schema) return null;

  let validator = compiledArgsSchemas.get(schema);
  if (!validator) {
    try {
      validator = argsSchemaValidator.compile(schema);
      compiledArgsSchemas.set(schema, validator);
    } catch (error) {
      return `cannot validate args for action "${actionName}": invalid input schema (${
        error instanceof Error ? error.message : String(error)
      })`;
    }
  }
  if (validator(args)) return null;
  return `args do not satisfy the input schema for action "${actionName}": ${argsSchemaValidator.errorsText(
    validator.errors,
    { dataVar: "args", separator: "; " },
  )}`;
}
