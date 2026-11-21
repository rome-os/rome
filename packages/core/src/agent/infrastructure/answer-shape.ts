// Reads an agent's answer shape with the packaging's portable JSON Schema
// rules, the same ones an app's agent file is checked against when it loads.

import {
  compileOutputSchema,
  formatOutputSchemaErrors,
} from "../../lib/output-schema-validator.js";
import type { ReadAnswerShape } from "../domain/answer-shape.js";

export const readAnswerShape: ReadAnswerShape = (schema) => {
  const compiled = compileOutputSchema(schema);
  return {
    check(answer) {
      if (compiled.validate(answer)) return { fits: true };
      return { fits: false, issues: formatOutputSchemaErrors(compiled.validate.errors) };
    },
  };
};
