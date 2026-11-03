// Recognizes pnpm output from a dependency build that found no C or C++
// toolchain. The production image ships neither `make` nor a compiler, and the
// system:custom-dependencies skill covers the ways around that.

const TOOLCHAIN = String.raw`(?:make|gmake|cc|c\+\+|gcc|g\+\+|clang|clang\+\+)`;
const COMPILER = String.raw`(?:cc|c\+\+|gcc|g\+\+|clang|clang\+\+)`;

const MISSING_TOOLCHAIN_PATTERNS = [
  // node-gyp looks up make before it builds: "gyp ERR! stack Error: not found: make".
  /\bnot found: g?make\b/,
  // make runs but finds no compiler: "make: cc: No such file or directory".
  new RegExp(String.raw`\bmake: ${COMPILER}: (?:No such file or directory|Command not found)`),
  // An install script calls the tool itself: "sh: 1: make: not found".
  new RegExp(String.raw`\bsh: \d+: ${TOOLCHAIN}: not found`),
];

// pnpm prefixes each line a dependency's install script prints with
// ".../node_modules/<name> <script>: ". The app's own scripts carry no such
// prefix, so a build the app runs itself never gets the hint.
const DEPENDENCY_SCRIPT_LINE = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+) (?:pre|post)?install: (.*)$/;

/**
 * Returns a hint, starting with a newline, when `output` shows a dependency's
 * install script failing for lack of `make` or a C or C++ compiler. Returns ""
 * for any other output, including a compile error from a toolchain that is
 * present.
 */
export function nativeBuildHint(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const match = DEPENDENCY_SCRIPT_LINE.exec(line);
    if (!match) continue;
    const [, name, text] = match;
    if (!MISSING_TOOLCHAIN_PATTERNS.some((pattern) => pattern.test(text))) continue;
    // The key is quoted because YAML rejects a bare key that starts with "@".
    const allowBuildsKey = JSON.stringify(name);
    return (
      `\nHint: building ${name} needs make and a C or C++ compiler, and Rome's image ships ` +
      `neither. If ${name} bundles a prebuilt binary, declining its build usually works: set ` +
      `\`${allowBuildsKey}: false\` under \`allowBuilds\` in the app's pnpm-workspace.yaml. ` +
      `The system:custom-dependencies skill covers the other options.`
    );
  }
  return "";
}
