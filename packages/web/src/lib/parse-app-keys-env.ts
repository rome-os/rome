import { APP_KEY_MAX_VALUE_LENGTH, appKeyNameError } from "@rome/api-types/app-keys";

export interface EnvAppKey {
  name: string;
  value: string;
  source: string;
}

type EnvError = {
  line: number;
  reason: "assignment" | "quote" | "duplicate" | "emptyValue" | "longValue" | "name";
  detail?: string;
};

/** Parses literal .env values without variable expansion or shell evaluation.
 * Rejects the entire input on invalid app keys or ambiguous duplicate names.
 * Sources preserve quoting so failed saves can be retried without changing values. */
export function parseAppKeysEnv(
  input: string,
): { entries: EnvAppKey[]; error?: never } | { entries?: never; error: EnvError } {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const entries: EnvAppKey[] = [];
  const names = new Set<string>();

  for (let index = 0; index < lines.length; index++) {
    const start = index;
    const line = lines[index].trimStart();
    if (!line || line.startsWith("#")) continue;

    const assignment = /^(?:export\s+)?([^\s=]+)\s*=\s*(.*)$/.exec(line);
    const fail = (reason: EnvError["reason"], detail?: string) => ({
      error: { line: start + 1, reason, detail },
    });
    if (!assignment) return fail("assignment");

    const [, name, raw] = assignment;
    const nameError = appKeyNameError(name);
    if (nameError) return fail("name", nameError);
    if (names.has(name)) return fail("duplicate");

    let value = raw;
    const quote = raw[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let quoted = raw.slice(1);
      let end = -1;
      while (true) {
        // Escaped quotes stay in the value, matching .env's literal backslashes.
        for (let cursor = 0; cursor < quoted.length; cursor++) {
          if (quoted[cursor] === "\\" && quoted[cursor + 1] === quote) {
            cursor++;
          } else if (quoted[cursor] === quote) {
            end = cursor;
            break;
          }
        }
        if (end !== -1) break;
        index++;
        if (index >= lines.length) return fail("quote");
        quoted += `\n${lines[index]}`;
      }
      const suffix = quoted.slice(end + 1).trim();
      if (suffix && !suffix.startsWith("#")) return fail("quote");
      value = quoted.slice(0, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      value = raw.split("#", 1)[0].trim();
    }

    if (!value) return fail("emptyValue");
    if (value.length > APP_KEY_MAX_VALUE_LENGTH) return fail("longValue");
    names.add(name);
    entries.push({ name, value, source: lines.slice(start, index + 1).join("\n") });
  }

  return { entries };
}
