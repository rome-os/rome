import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readNativeResult } from "./native-results.mjs";

const escapeAttribute = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

export async function writeNativeSummary({ reportsDirectory, pagesUrl, output, requireReport = false }) {
  const root = path.resolve(reportsDirectory);
  const result = await readNativeResult(root);
  if (!result) throw new Error("Native Midscene results are missing");
  const publicRoot = pagesUrl && result.reportPath ? new URL(`${pagesUrl.replace(/\/$/, "")}/`) : null;
  if (publicRoot && !["http:", "https:"].includes(publicRoot.protocol)) {
    throw new Error("The report URL must use HTTP or HTTPS");
  }
  const file = result.markdownPath;
  const resolveLink = (value) => {
    const target = new URL(value.replaceAll("&amp;", "&"), pathToFileURL(file));
    if (target.protocol !== "file:") throw new Error("Expected a relative report asset link");
    const relative = path.relative(root, decodeURIComponent(target.pathname));
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("Report asset link escapes the artifact directory");
    }
    if (!publicRoot) return null;
    const url = new URL(relative.split(path.sep).map(encodeURIComponent).join("/"), publicRoot);
    url.search = target.search;
    url.hash = target.hash;
    return url.href;
  };
  const markdown = (await readFile(file, "utf8"))
    .replace(/\[([^\]\n]*)\]\(<([^>\n]+)>\)/g, (_match, label, target) => {
      const url = resolveLink(target);
      return url ? `[${label}](<${url}>)` : label;
    })
    .replace(/<img src="([^"]+)" alt="([^"]*)" width="160">/g, (_match, source, alt) => {
      const url = resolveLink(source);
      return url ? `<img src="${escapeAttribute(url)}" alt="${alt}" width="160">` : "—";
    });
  await writeFile(output, markdown);
  if (requireReport && !result.reportPath) throw new Error("Native HTML report is missing");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportsDirectory, pagesUrl, output, option] = process.argv.slice(2);
  if (!reportsDirectory || !output) throw new Error("Usage: write-native-summary.mjs <reports-dir> <pages-url-or-empty> <output> [--require-report]");
  if (option && option !== "--require-report") throw new Error(`Unknown option: ${option}`);
  await writeNativeSummary({ reportsDirectory, pagesUrl, output, requireReport: option === "--require-report" });
}
