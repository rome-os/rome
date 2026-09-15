import type { FileBrowserScope } from "./file-browser-server.js";

export const PROJECT_FILE_BROWSER_POLICY = {
  treeIgnoredNames: [],
  watchIgnoredNames: [],
  uploadIgnoredNames: [],
  downloadIgnoredNames: ["node_modules"],
  searchGlobs: [
    "!**/.git/**",
    "!**/.next/**",
    "!**/.turbo/**",
    "!**/build/**",
    "!**/coverage/**",
    "!**/dist/**",
    "!**/node_modules/**",
  ],
} satisfies Pick<
  FileBrowserScope,
  | "treeIgnoredNames"
  | "watchIgnoredNames"
  | "uploadIgnoredNames"
  | "downloadIgnoredNames"
  | "searchGlobs"
>;
