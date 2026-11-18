/**
 * The files a shell command plainly writes, read from its text: a `>` or `>>`
 * redirect's target, `tee`'s files, `touch`'s files, and where `cp` or `mv`
 * puts a file. A file a script or program writes from inside is not seen.
 * docs/domains/chats.md#outputs
 */

/** A command split into words and the operators between them. */
type Token = { word: string } | { op: string };

const OPERATORS = ["&&", "||", ";;", "|&", ">>", "&>", ">|", "<<", ";", "|", "&", ">", "<", "\n"];

/** Drops each here-document's body, so its lines are not read as commands. */
function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let ending: string | null = null;
  for (const line of lines) {
    if (ending !== null) {
      if (line.trim() === ending) ending = null;
      continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (heredoc) ending = heredoc[2];
  }
  return kept.join("\n");
}

/**
 * Splits `command` into words, with quotes and backslashes undone, and
 * operators. A word holding a substitution (`$`, a backquote) keeps it as
 * text, so it never names a real path.
 */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let inWord = false;
  const end = () => {
    if (inWord) tokens.push({ word });
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      const stop = close === -1 ? command.length : close;
      word += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (char === '"') {
      inWord = true;
      for (i++; i < command.length && command[i] !== '"'; i++) {
        if (command[i] === "\\" && i + 1 < command.length) i++;
        word += command[i];
      }
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      if (command[i + 1] !== "\n") word += command[i + 1];
      inWord = true;
      i++;
      continue;
    }
    if (char === "#" && !inWord) {
      while (i < command.length && command[i] !== "\n") i++;
      i--;
      continue;
    }
    if (char === " " || char === "\t") {
      end();
      continue;
    }
    // `2>`, `1>>`: a file descriptor's digit belongs to the redirect.
    const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
    if (op) {
      if (/^\d+$/.test(word) && op.startsWith(">")) {
        word = "";
        inWord = false;
      }
      end();
      tokens.push({ op });
      i += op.length - 1;
      // `>&2`: a redirect to another descriptor writes no file.
      if (op.startsWith(">") && command[i + 1] === "&") {
        i++;
        while (i + 1 < command.length && /[\d-]/.test(command[i + 1])) i++;
        tokens.pop();
      }
      continue;
    }
    word += char;
    inWord = true;
  }
  end();
  return tokens;
}

/** Whether `word` can name a file: not a device, a descriptor or a substitution. */
function isFileWord(word: string): boolean {
  if (!word || word === "-" || word.startsWith("/dev/")) return false;
  return !/[$`*?]/.test(word);
}

const COMMAND_SEPARATORS = new Set(["&&", "||", ";", ";;", "|", "|&", "&", "\n"]);

/** Wrappers a command runs under, which leave the command after them. */
const PREFIXES = new Set(["sudo", "command", "builtin", "exec", "nohup", "time"]);

/** The files simple command `words` writes, by what it runs. */
function writesOf(words: string[]): string[] {
  let start = 0;
  while (start < words.length && (PREFIXES.has(words[start]) || /^\w+=/.test(words[start]))) {
    start++;
  }
  const [name, ...rest] = words.slice(start);
  if (!name) return [];
  // `bash -lc "<script>"`, as Codex runs every command: the script's writes.
  if (/(^|\/)(ba|z|da)?sh$/.test(name)) {
    const flag = rest.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    const script = flag === -1 ? undefined : rest[flag + 1];
    return script === undefined ? [] : shellWrites(script);
  }
  const args = rest.filter((arg) => !arg.startsWith("-"));
  switch (name) {
    case "tee":
    case "touch":
      return args;
    case "cp":
    case "mv":
    case "install": {
      // `-t DIR` puts files in a folder; a folder target names no single file.
      if (rest.some((arg) => arg === "-t" || arg.startsWith("--target-directory"))) return [];
      return args.length >= 2 ? [args[args.length - 1]] : [];
    }
    default:
      return [];
  }
}

/** The files shell command `command` writes, as written in it: relative or absolute. */
export function shellWrites(command: string): string[] {
  const tokens = tokenize(withoutHeredocs(command));
  const found: string[] = [];
  let words: string[] = [];
  const flush = () => {
    found.push(...writesOf(words));
    words = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ("word" in token) {
      words.push(token.word);
      continue;
    }
    if (COMMAND_SEPARATORS.has(token.op)) {
      flush();
      continue;
    }
    const next = tokens[i + 1];
    const target = next && "word" in next ? next.word : null;
    if (target !== null) i++;
    if (
      (token.op === ">" || token.op === ">>" || token.op === "&>" || token.op === ">|") &&
      target
    ) {
      found.push(target);
    }
    // `<` and `<<` take a word that is read, not written.
  }
  flush();
  return [...new Set(found.filter(isFileWord))];
}
