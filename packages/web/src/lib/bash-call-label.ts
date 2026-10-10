interface BashActionDescription {
  inProgress: string;
  completed: string;
  kind?: "move" | "write";
  path?: string;
  sourcePath?: string;
}

const QUERY_LABEL_MAX_LENGTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function displayQuery(query: string): string {
  return query
    .replace(/\\(["'])/g, "$1")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\\+\|/g, " | ")
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\\([{}()[\].*+?^$])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function displayPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return path;
  if (parts.length <= 2) return parts.join("/");
  return `.../${parts.slice(-2).join("/")}`;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens.filter(Boolean);
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== "'" && quote !== '"') || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }
  return trimmed.slice(1, -1);
}

function unescapeShellWrapperText(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\'/g, "'");
}

function shellWrapperInner(command: string): string | null {
  const match = command.match(/^\s*(?:\S*\/)?(?:bash|sh|zsh)\s+-[A-Za-z]*c[A-Za-z]*\s+([\s\S]+)$/);
  return match ? unescapeShellWrapperText(stripOuterQuotes(match[1])) : null;
}

function unwrappedCommand(command: string): string {
  let current = command.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const innerFromRaw = shellWrapperInner(current);
    if (innerFromRaw) {
      current = innerFromRaw;
      continue;
    }

    const tokens = tokenizeCommand(current);
    const executable = tokens[0]?.split("/").pop();
    const commandArgIndex = tokens.findIndex(
      (token, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(token),
    );
    if (!executable || !["bash", "sh", "zsh"].includes(executable) || commandArgIndex < 0) {
      return current;
    }

    const inner = tokens[commandArgIndex + 1];
    if (!inner) return current;
    current = unescapeShellWrapperText(stripOuterQuotes(inner));
  }
  return current;
}

function unwrappedCommandPreview(command: string): string | null {
  const unwrapped = unwrappedCommand(command);
  if (unwrapped === command.trim()) return null;
  return unwrapped.replace(/\s+/g, " ").trim() || null;
}

function redirectionTargetIndexes(tokens: string[]): Set<number> {
  const targets = new Set<number>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    if (/^(?:\d*)[<>]+&?$/.test(token) || /^(?:&>|&>>|>\||<<-?)$/.test(token)) {
      targets.add(i + 1);
    }
  }
  return targets;
}

function lastPathArg(tokens: string[], startAt = 1): string | null {
  const redirectionTargets = redirectionTargetIndexes(tokens);
  for (let i = tokens.length - 1; i >= startAt; i -= 1) {
    const token = tokens[i];
    if (redirectionTargets.has(i)) continue;
    if (!token || token.startsWith("-")) continue;
    if (/^(?:\d*)[<>]/.test(token)) continue;
    if (/^\d+,\d+p$/.test(token)) continue;
    return token;
  }
  return null;
}

function tokensBeforePipe(tokens: string[]): string[] {
  const pipeIndex = tokens.findIndex((token) => token === "|" || token === "|&");
  return pipeIndex < 0 ? tokens : tokens.slice(0, pipeIndex);
}

function stdoutRedirectTarget(tokens: string[]): string | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const attached = token.match(/^(?:&>>|&>|1>>|1>|>>|>\||>)(.+)$/)?.[1];
    if (attached) return attached;
    if (/^(?:&>>|&>|1>>|1>|>>|>\||>)$/.test(token)) return tokens[i + 1] ?? null;
  }
  return null;
}

function hasHereDoc(tokens: string[]): boolean {
  return tokens.some((token) => /^(?:<<|<<-)/.test(token));
}

function hasSedInPlaceFlag(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      token === "-i" ||
      token.startsWith("--in-place") ||
      (/^-[A-Za-z]*i/.test(token) && token !== "-"),
  );
}

function heredocDelimiter(line: string): string | null {
  const match = line.match(/<<-?\s*(\S+)/);
  if (!match) return null;
  const delimiter = match[1].replace(/[^A-Za-z0-9_]/g, "");
  return delimiter || null;
}

function stripHeredocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    kept.push(line);
    const delimiter = heredocDelimiter(line);
    if (!delimiter) continue;

    while (i + 1 < lines.length && lines[i + 1].trim() !== delimiter) {
      i += 1;
    }
    if (i + 1 < lines.length) i += 1;
  }

  return kept.join("\n");
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const commandWithoutHeredocBodies = stripHeredocBodies(command);

  for (let i = 0; i < commandWithoutHeredocBodies.length; i += 1) {
    const char = commandWithoutHeredocBodies[i];
    const next = commandWithoutHeredocBodies[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if ((char === "'" || char === '"') && quote === null) {
      quote = char;
      current += char;
      continue;
    }

    if (char === quote) {
      quote = null;
      current += char;
      continue;
    }

    if (
      quote === null &&
      (char === "\n" ||
        char === ";" ||
        (char === "&" && next === "&") ||
        (char === "|" && next === "|"))
    ) {
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
      if (char !== ";" && char !== "\n") i += 1;
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments;
}

function gitGrepQuery(tokens: string[]): string | null {
  if (tokens[0] !== "git") return null;
  const grepIndex = tokens.indexOf("grep");
  if (grepIndex < 0) return null;
  return grepSearchQuery(tokens.slice(grepIndex));
}

const GREP_OPTIONS_WITH_VALUES = new Set([
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "-D",
  "--devices",
  "-d",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "-f",
  "--file",
  "--include",
  "--label",
  "-m",
  "--max-count",
]);

const GREP_SHORT_OPTIONS_WITH_VALUES = new Set(["A", "B", "C", "D", "d", "f", "m"]);
const GREP_SHORT_REGEX_OPTIONS = new Set(["e"]);

function grepSearchQuery(tokens: string[]): string | null {
  const positionals: string[] = [];
  const regexps: string[] = [];
  let parseOptions = true;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }

    if (parseOptions && (token === "-e" || token === "--regexp")) {
      const value = tokens[++i];
      if (value) regexps.push(value);
      continue;
    }

    if (parseOptions && token.startsWith("--regexp=")) {
      regexps.push(token.slice("--regexp=".length));
      continue;
    }

    if (parseOptions && token.startsWith("--")) {
      const [option] = token.split("=", 1);
      if (!token.includes("=") && GREP_OPTIONS_WITH_VALUES.has(option)) i += 1;
      continue;
    }

    if (parseOptions && /^-[^-]/.test(token)) {
      const optionChars = token.slice(1);
      const regexOptionIndex = [...optionChars].findIndex((char) =>
        GREP_SHORT_REGEX_OPTIONS.has(char),
      );
      if (regexOptionIndex >= 0) {
        const attachedValue = optionChars.slice(regexOptionIndex + 1);
        const value = attachedValue || tokens[++i];
        if (value) regexps.push(value);
        continue;
      }

      const valueOptionIndex = [...optionChars].findIndex((char) =>
        GREP_SHORT_OPTIONS_WITH_VALUES.has(char),
      );
      if (valueOptionIndex >= 0 && valueOptionIndex === optionChars.length - 1) i += 1;
      continue;
    }

    positionals.push(token);
  }

  return regexps[0] ?? positionals[0] ?? null;
}

const RG_OPTIONS_WITH_VALUES = new Set([
  "-A",
  "--after-context",
  "-B",
  "--before-context",
  "-C",
  "--context",
  "--color",
  "--colors",
  "--context-separator",
  "--dfa-size-limit",
  "-E",
  "--encoding",
  "--engine",
  "--field-context-separator",
  "--field-match-separator",
  "-f",
  "--file",
  "-g",
  "--glob",
  "--hostname-bin",
  "--iglob",
  "--ignore-file",
  "-j",
  "--threads",
  "-M",
  "-m",
  "--max-count",
  "--max-columns",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--pre",
  "--pre-glob",
  "-r",
  "--replace",
  "--regex-size-limit",
  "--sort",
  "--sortr",
  "-t",
  "--type",
  "-T",
  "--type-not",
]);

const RG_REGEX_OPTIONS = new Set(["-e", "--regexp"]);

const RG_SHORT_OPTIONS_WITH_VALUES = new Set([
  "A",
  "B",
  "C",
  "E",
  "f",
  "g",
  "j",
  "M",
  "m",
  "r",
  "t",
  "T",
]);

const RG_SHORT_REGEX_OPTIONS = new Set(["e"]);

interface ParsedRgTokens {
  filesOnly: boolean;
  positionals: string[];
  regexps: string[];
}

function parseRgTokens(tokens: string[]): ParsedRgTokens {
  const positionals: string[] = [];
  const regexps: string[] = [];
  let filesOnly = false;
  let parseOptions = true;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }

    if (parseOptions && token === "--files") {
      filesOnly = true;
      continue;
    }

    if (parseOptions && token.startsWith("--") && RG_REGEX_OPTIONS.has(token.split("=", 1)[0])) {
      const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : tokens[++i];
      if (value) regexps.push(value);
      continue;
    }

    if (parseOptions && token.startsWith("--")) {
      const [option] = token.split("=", 1);
      if (!token.includes("=") && RG_OPTIONS_WITH_VALUES.has(option)) i += 1;
      continue;
    }

    if (parseOptions && /^-[^-]/.test(token)) {
      const optionChars = token.slice(1);
      const regexOptionIndex = [...optionChars].findIndex((char) =>
        RG_SHORT_REGEX_OPTIONS.has(char),
      );
      if (regexOptionIndex >= 0) {
        const attachedValue = optionChars.slice(regexOptionIndex + 1);
        const value = attachedValue || tokens[++i];
        if (value) regexps.push(value);
        continue;
      }

      const valueOptionIndex = [...optionChars].findIndex((char) =>
        RG_SHORT_OPTIONS_WITH_VALUES.has(char),
      );
      if (valueOptionIndex >= 0 && valueOptionIndex === optionChars.length - 1) i += 1;
      continue;
    }

    positionals.push(token);
  }

  return { filesOnly, positionals, regexps };
}

function describeRgCommand(tokens: string[]): BashActionDescription | null {
  const parsed = parseRgTokens(tokens);
  if (parsed.filesOnly) {
    const path = parsed.positionals.at(-1);
    const target = path ? ` in ${displayPath(path)}` : "";
    return { inProgress: `Listing files${target}`, completed: `Listed files${target}` };
  }

  const query = parsed.regexps[0] ?? parsed.positionals[0];
  const target = query ? ` for "${truncate(displayQuery(query), QUERY_LABEL_MAX_LENGTH)}"` : "";
  return { inProgress: `Searching${target}`, completed: `Search results${target}` };
}

function writeDescription(path: string): BashActionDescription {
  const target = basename(path);
  return { inProgress: `Writing ${target}`, completed: `Wrote ${target}`, kind: "write", path };
}

function moveDescription(tokens: string[]): BashActionDescription | null {
  const paths = tokens.slice(1).filter((token) => token && !token.startsWith("-"));
  if (paths.length < 2) return null;
  const sourcePath = paths[paths.length - 2];
  const path = paths[paths.length - 1];
  const target = basename(path);
  return {
    inProgress: `Writing ${target}`,
    completed: `Wrote ${target}`,
    kind: "move",
    path,
    sourcePath,
  };
}

const FIND_LEADING_FLAGS = new Set(["-H", "-L", "-P"]);
const FIND_LEADING_OPTIONS_WITH_VALUES = new Set(["-D", "-O"]);

const FIND_PREDICATES_WITH_VALUES = new Set([
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-context",
  "-ctime",
  "-exec",
  "-execdir",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-iwholename",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-regex",
  "-samefile",
  "-size",
  "-type",
  "-uid",
  "-user",
  "-wholename",
]);

function findPathArg(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (FIND_LEADING_FLAGS.has(token)) continue;
    if (FIND_LEADING_OPTIONS_WITH_VALUES.has(token)) {
      i += 1;
      continue;
    }
    if (/^-O\d+$/.test(token)) continue;

    if (FIND_PREDICATES_WITH_VALUES.has(token) || token.startsWith("-")) return null;

    return token;
  }
  return null;
}

function describeAction(action: Record<string, unknown>): BashActionDescription | null {
  switch (action.type) {
    case "read": {
      const path = asString(action.path);
      const name = asString(action.name);
      const target = path ? basename(path) : name;
      return target ? { inProgress: `Reading ${target}`, completed: `Read ${target}` } : null;
    }
    case "listFiles": {
      const path = asString(action.path);
      const target = path ? ` in ${displayPath(path)}` : "";
      return { inProgress: `Listing files${target}`, completed: `Listed files${target}` };
    }
    case "search": {
      const query = asString(action.query);
      const path = asString(action.path);
      const target = query ? ` for "${truncate(displayQuery(query), QUERY_LABEL_MAX_LENGTH)}"` : "";
      const scope = path ? ` in ${displayPath(path)}` : "";
      return {
        inProgress: `Searching${target}${scope}`,
        completed: `Search results${target}${scope}`,
      };
    }
    default:
      return null;
  }
}

function describeCommandSegment(command: string): BashActionDescription | null {
  const tokens = tokenizeCommand(command);
  const executable = tokens[0]?.split("/").pop();
  if (!executable) return null;

  if (["cat", "sed", "head", "tail", "nl"].includes(executable)) {
    const readerTokens = tokensBeforePipe(tokens);
    const writeTarget = stdoutRedirectTarget(readerTokens);
    if (writeTarget) {
      return writeDescription(writeTarget);
    }
    if (executable === "cat" && hasHereDoc(readerTokens)) return null;
    if (executable === "sed" && hasSedInPlaceFlag(readerTokens)) {
      const path = lastPathArg(readerTokens);
      if (!path) return null;
      return writeDescription(path);
    }
    const path = lastPathArg(readerTokens);
    if (!path) return null;
    const target = basename(path);
    return { inProgress: `Reading ${target}`, completed: `Read ${target}` };
  }

  if (executable === "ls") {
    const path = lastPathArg(tokens);
    const target = path ? ` in ${displayPath(path)}` : "";
    return { inProgress: `Listing files${target}`, completed: `Listed files${target}` };
  }

  if (executable === "find") {
    const path = findPathArg(tokens);
    const target = path ? ` in ${displayPath(path)}` : "";
    return { inProgress: `Listing files${target}`, completed: `Listed files${target}` };
  }

  if (executable === "rg") {
    return describeRgCommand(tokens);
  }

  if (executable === "grep") {
    const query = grepSearchQuery(tokens);
    const target = query ? ` for "${truncate(displayQuery(query), QUERY_LABEL_MAX_LENGTH)}"` : "";
    return { inProgress: `Searching${target}`, completed: `Search results${target}` };
  }

  if (executable === "git") {
    const query = gitGrepQuery(tokens);
    if (!query) return null;
    const target = ` for "${truncate(displayQuery(query), QUERY_LABEL_MAX_LENGTH)}"`;
    return { inProgress: `Searching${target}`, completed: `Search results${target}` };
  }

  if (executable === "mv") {
    return moveDescription(tokens);
  }

  if (executable === "cp") {
    const paths = tokens.slice(1).filter((t) => t && !t.startsWith("-"));
    if (paths.length < 2) return null;
    const path = paths[paths.length - 1];
    const target = basename(path);
    return { inProgress: `Copying ${target}`, completed: `Copied ${target}`, kind: "write", path };
  }

  return null;
}

function collapseTempWrites(descriptions: BashActionDescription[]): BashActionDescription[] {
  const collapsed: BashActionDescription[] = [];
  for (let i = 0; i < descriptions.length; i += 1) {
    const description = descriptions[i];
    const next = descriptions[i + 1];
    if (
      description.kind === "write" &&
      description.path &&
      next?.kind === "move" &&
      next.sourcePath === description.path &&
      next.path
    ) {
      collapsed.push(writeDescription(next.path));
      i += 1;
      continue;
    }
    collapsed.push(description);
  }
  return collapsed;
}

function describeActions(actions: unknown, phase: "inProgress" | "completed"): string | null {
  if (!Array.isArray(actions) || actions.length === 0) return null;
  const descriptions = actions.map((action) => (isRecord(action) ? describeAction(action) : null));
  if (descriptions.some((description) => description === null)) return null;
  const [first] = descriptions as BashActionDescription[];
  return descriptions.length === 1
    ? first[phase]
    : `${first[phase]} + ${descriptions.length - 1} more`;
}

function describeCommand(command: string, phase: "inProgress" | "completed"): string | null {
  const unwrapped = unwrappedCommand(command);
  const descriptions = collapseTempWrites(
    splitShellSegments(unwrapped)
      .map(describeCommandSegment)
      .filter((description): description is BashActionDescription => description !== null),
  );
  if (descriptions.length === 0) return null;
  const [first] = descriptions;
  return descriptions.length === 1
    ? first[phase]
    : `${first[phase]} + ${descriptions.length - 1} more`;
}

export function describeBashCall(input: unknown, phase: "inProgress" | "completed"): string | null {
  if (!isRecord(input)) return null;
  const fromActions = describeActions(input.commandActions, phase);
  if (fromActions) return fromActions;

  const command = asString(input.command);
  if (!command) return null;
  return describeCommand(command, phase) ?? unwrappedCommandPreview(command);
}
