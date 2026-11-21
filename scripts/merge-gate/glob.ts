// Glob matching for merge-policy paths. Contract: `**` crosses folders, `*`
// and `?` stay inside one path segment. Every other character is literal.

const cache = new Map<string, RegExp>();

/** True when the repo-relative `path` matches `glob` in full. */
export function matchesGlob(glob: string, path: string): boolean {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re.test(path);
}

// Compiles a glob to an anchored RegExp. A `**` that fills a whole segment
// also matches zero segments, so `a/**/b` matches `a/b` and `**/x` matches `x`.
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const atSegmentStart = i === 0 || glob[i - 1] === "/";
      const atSegmentEnd = i + 2 === glob.length || glob[i + 2] === "/";
      if (atSegmentStart && atSegmentEnd) {
        if (i + 2 === glob.length) {
          // Trailing `**`: everything below the folder, but not the folder.
          out += i === 0 ? ".*" : ".+";
          i += 2;
        } else {
          // `**/`: zero or more whole segments.
          out += "(?:[^/]*/)*";
          i += 3;
        }
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}
