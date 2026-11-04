import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

// `useDefaults` fills a defaulted field before `required` runs. `defineAction`
// emits its schema with `z.toJSONSchema`, which lists every `.default()` field
// as required, though the action's own parse fills the field in.
const argsSchemaValidator = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
const compiledArgsSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

// RoutineEngine merges the trigger payload into args under this key on every
// fire, and routine args may not contain it, so a schema that requires it
// (e.g. a webhook handler) must not reject the stored args for lacking it.
const TRIGGER_PAYLOAD_KEY = "__triggerPayload";

/** The schema routine args are checked against: the action's own, minus
 * `__triggerPayload` in its top-level `required`. */
function storedArgsSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { required } = schema;
  if (!Array.isArray(required) || !required.includes(TRIGGER_PAYLOAD_KEY)) return schema;
  return { ...schema, required: required.filter((key) => key !== TRIGGER_PAYLOAD_KEY) };
}

/** Check routine args against the bound action's input schema, so a routine
 * can't be saved with args that fail on every fire. Shared by
 * `POST /api/routines` (the card's "Turn it on"), `create_routine` (through
 * `ActionRegistryImpl.validateArgs`) and `propose_routine`'s auto-enable gate.
 * `__triggerPayload` is not required here: the engine supplies it at fire time.
 * Returns an error message, or null when the args fit (or the action declares
 * no schema). Never modifies `args`. */
export function validateActionArgs(
  actionName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (!schema) return null;

  let validator = compiledArgsSchemas.get(schema);
  if (!validator) {
    try {
      validator = argsSchemaValidator.compile(storedArgsSchema(schema));
      compiledArgsSchemas.set(schema, validator);
    } catch (error) {
      return `cannot validate args for action "${actionName}": invalid input schema (${
        error instanceof Error ? error.message : String(error)
      })`;
    }
  }
  // Validate a copy: `useDefaults` writes the defaults into the value it checks.
  if (validator(structuredClone(args))) return null;
  return `args do not satisfy the input schema for action "${actionName}": ${argsSchemaValidator.errorsText(
    validator.errors,
    { dataVar: "args", separator: "; " },
  )}`;
}
